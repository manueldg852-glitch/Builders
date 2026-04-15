/**
 * RestoraFlow v5 — PDF Report Engine
 * Powered by Puppeteer + BullMQ (background processing)
 * Generates IICRC-compliant insurance documentation
 */

import puppeteer, { Browser, Page } from 'puppeteer'
import { Injectable, Logger } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue, Worker, Job } from 'bullmq'
import * as Handlebars from 'handlebars'
import * as path from 'path'
import * as fs from 'fs/promises'
import { MinioService } from '../storage/minio.service'
import { PrismaService } from '../database/prisma.service'
import type { Project, Room, Photo, MoistureLog } from '@prisma/client'

const PDF_QUEUE = 'pdf-generation'

// ─── Queue Job Definitions ──────────────────────────────────

export interface GenerateReportJob {
  projectId: string
  companyId: string
  requestedById: string
  options: {
    reportType: 'full' | 'photo_log' | 'executive_summary' | 'moisture_report'
    paperSize: 'letter' | 'a4'
    includeAiNarratives: boolean
    watermark?: 'DRAFT' | 'CONFIDENTIAL' | null
    photoQuality: 'high' | 'medium'
  }
}

// ─── PDF Service ────────────────────────────────────────────

@Injectable()
export class PdfGenerationService {
  private readonly logger = new Logger(PdfGenerationService.name)
  private browser: Browser | null = null

  constructor(
    @InjectQueue(PDF_QUEUE) private readonly pdfQueue: Queue,
    private readonly minio: MinioService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    this.browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=none',
      ],
    })
    this.logger.log('Puppeteer browser initialized')
  }

  async onModuleDestroy() {
    await this.browser?.close()
  }

  /**
   * Enqueue a PDF generation job (non-blocking)
   */
  async enqueueReport(data: GenerateReportJob): Promise<string> {
    const job = await this.pdfQueue.add('generate-report', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 20 },
    })
    this.logger.log(`Enqueued PDF job ${job.id} for project ${data.projectId}`)
    return job.id as string
  }

  /**
   * Generate PDF immediately (blocking — use for small reports)
   */
  async generateImmediate(projectId: string, options: GenerateReportJob['options']): Promise<Buffer> {
    const data = await this.fetchProjectData(projectId)
    const html = await this.renderTemplate(data, options)
    return this.htmlToPdf(html, options.paperSize)
  }

  /**
   * Full project data fetch with all relations
   */
  private async fetchProjectData(projectId: string) {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: {
        company: true,
        leadTechnician: { include: { certifications: false } },
        client: true,
        rooms: {
          orderBy: { sortOrder: 'asc' },
          include: {
            photos: {
              where: { category: { in: ['DAMAGE', 'BEFORE', 'AFTER', 'PROGRESS'] } },
              orderBy: { createdAt: 'asc' },
              take: 8,
            },
            moistureLogs: { orderBy: { readingDate: 'asc' } },
            floorPins: { orderBy: { severity: 'desc' } },
            equipment: {
              include: { equipment: true },
              where: { removedAt: null },
            },
          },
        },
        milestones: { orderBy: { sortOrder: 'asc' } },
        signatures: { where: { status: 'SIGNED' } },
        invoices: { where: { status: { in: ['SENT', 'PAID'] } }, take: 1 },
      },
    })

    // Generate pre-signed URLs for photos
    const roomsWithUrls = await Promise.all(
      project.rooms.map(async (room) => ({
        ...room,
        photos: await Promise.all(
          room.photos.map(async (photo) => ({
            ...photo,
            url: await this.minio.getPresignedUrl(photo.storageKey, 3600),
            thumbnailUrl: photo.thumbnailKey
              ? await this.minio.getPresignedUrl(photo.thumbnailKey, 3600)
              : null,
          }))
        ),
      }))
    )

    return { ...project, rooms: roomsWithUrls }
  }

  /**
   * Render Handlebars HTML template
   */
  private async renderTemplate(
    data: Awaited<ReturnType<typeof this.fetchProjectData>>,
    options: GenerateReportJob['options'],
  ): Promise<string> {
    const templatePath = path.join(__dirname, '../templates', `report-${options.reportType}.hbs`)
    const templateSource = await fs.readFile(templatePath, 'utf-8')

    Handlebars.registerHelper('formatDate', (date: Date) =>
      date ? new Date(date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—'
    )
    Handlebars.registerHelper('formatCurrency', (amount: number) =>
      new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
    )
    Handlebars.registerHelper('dmgLabel', (score: number) =>
      score >= 9 ? 'Catastrophic' : score >= 7 ? 'Severe' : score >= 5 ? 'Moderate' : score >= 3 ? 'Minor' : 'Minimal'
    )
    Handlebars.registerHelper('mcStatus', (value: number) =>
      value >= 75 ? 'Saturated' : value >= 55 ? 'Wet' : value >= 30 ? 'Elevated' : 'Dry'
    )
    Handlebars.registerHelper('progress', (completed: number, total: number) =>
      total > 0 ? Math.round((completed / total) * 100) : 0
    )
    Handlebars.registerHelper('chunked', (arr: any[], size: number) => {
      const chunks = []
      for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
      return chunks
    })

    const template = Handlebars.compile(templateSource)
    const completedMilestones = data.milestones.filter(m => m.isCompleted).length

    return template({
      project: data,
      company: data.company,
      client: data.client,
      rooms: data.rooms,
      milestones: data.milestones,
      completedMilestones,
      totalMilestones: data.milestones.length,
      progressPct: completedMilestones > 0 ? Math.round((completedMilestones / data.milestones.length) * 100) : 0,
      totalPhotos: data.rooms.reduce((s, r) => s + r.photos.length, 0),
      maxDamageScore: Math.max(...data.rooms.map(r => r.damageScore), 0),
      leadTechnician: data.leadTechnician,
      generatedAt: new Date(),
      reportId: `DR-${Date.now().toString(36).toUpperCase()}`,
      watermark: options.watermark,
      isFullReport: options.reportType === 'full',
    })
  }

  /**
   * Convert HTML to PDF buffer using Puppeteer
   */
  private async htmlToPdf(html: string, paperSize: 'letter' | 'a4'): Promise<Buffer> {
    if (!this.browser) throw new Error('Puppeteer not initialized')

    const page: Page = await this.browser.newPage()
    try {
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 })

      // Wait for all images to load
      await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'))
        return Promise.all(
          imgs.map(img =>
            img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; img.onerror = r })
          )
        )
      })

      const pdfBuffer = await page.pdf({
        format: paperSize === 'letter' ? 'Letter' : 'A4',
        printBackground: true,
        margin: { top: '0.75in', bottom: '0.75in', left: '0.75in', right: '0.75in' },
        displayHeaderFooter: true,
        headerTemplate: `
          <div style="width:100%;font-family:Inter,sans-serif;font-size:9px;color:#94A3B8;display:flex;justify-content:space-between;padding:0 0.75in;">
            <span>RestoraFlow — Confidential Report</span>
            <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
          </div>`,
        footerTemplate: `
          <div style="width:100%;font-family:Inter,sans-serif;font-size:8px;color:#CBD5E1;text-align:center;padding:0 0.75in;">
            This document has been prepared in accordance with IICRC S500/S520 standards. Generated by RestoraFlow.
          </div>`,
      })

      return Buffer.from(pdfBuffer)
    } finally {
      await page.close()
    }
  }

  /**
   * Save PDF to MinIO and update project
   */
  async savePdfToStorage(pdfBuffer: Buffer, projectId: string, reportId: string): Promise<string> {
    const storageKey = `reports/${projectId}/${reportId}.pdf`
    await this.minio.uploadBuffer(storageKey, pdfBuffer, 'application/pdf', {
      'x-restoraflow-report-id': reportId,
      'x-restoraflow-project-id': projectId,
      'x-restoraflow-generated-at': new Date().toISOString(),
    })

    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        reportGeneratedAt: new Date(),
        reportUrl: storageKey,
        reportVersion: { increment: 1 },
      },
    })

    return storageKey
  }
}

// ─── BullMQ Worker ──────────────────────────────────────────

@Injectable()
export class PdfWorker {
  private readonly logger = new Logger(PdfWorker.name)

  constructor(
    private readonly pdfService: PdfGenerationService,
    private readonly minio: MinioService,
    private readonly prisma: PrismaService,
  ) {
    this.initWorker()
  }

  private initWorker() {
    const worker = new Worker<GenerateReportJob>(
      PDF_QUEUE,
      async (job: Job<GenerateReportJob>) => {
        this.logger.log(`Processing PDF job ${job.id} for project ${job.data.projectId}`)
        await job.updateProgress(10)

        try {
          // Update job record in DB
          await this.updateJobStatus(job.data.projectId, job.id as string, 'ACTIVE')
          await job.updateProgress(20)

          // Generate PDF
          const pdfBuffer = await this.pdfService.generateImmediate(
            job.data.projectId,
            job.data.options,
          )
          await job.updateProgress(80)

          // Save to MinIO
          const reportId = `DR-${Date.now().toString(36).toUpperCase()}`
          const storageKey = await this.pdfService.savePdfToStorage(pdfBuffer, job.data.projectId, reportId)
          await job.updateProgress(95)

          // Log activity
          await this.prisma.activityLog.create({
            data: {
              companyId: job.data.companyId,
              userId: job.data.requestedById,
              projectId: job.data.projectId,
              action: 'report.generated',
              entityType: 'project',
              entityId: job.data.projectId,
              metadata: { reportId, storageKey, reportType: job.data.options.reportType },
            },
          })

          await job.updateProgress(100)
          this.logger.log(`PDF job ${job.id} completed — ${storageKey}`)
          return { storageKey, reportId }
        } catch (error) {
          this.logger.error(`PDF job ${job.id} failed:`, error)
          await this.updateJobStatus(job.data.projectId, job.id as string, 'FAILED', String(error))
          throw error
        }
      },
      {
        connection: { host: process.env.REDIS_HOST, port: 6379 },
        concurrency: 2,
        limiter: { max: 10, duration: 60000 },
      }
    )

    worker.on('completed', (job, result) => {
      this.logger.log(`✓ PDF job ${job.id} completed`)
    })
    worker.on('failed', (job, err) => {
      this.logger.error(`✗ PDF job ${job?.id} failed: ${err.message}`)
    })
  }

  private async updateJobStatus(projectId: string, bullJobId: string, status: string, error?: string) {
    await this.prisma.backgroundJob.updateMany({
      where: { projectId, bullJobId },
      data: { status: status as any, error, ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}) },
    })
  }
}
