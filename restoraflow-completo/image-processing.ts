/**
 * RestoraFlow v5 — Image Processing Service
 * Stack: Sharp + BullMQ + MinIO
 * 
 * Pipeline: Upload → Queue → Sharp (WebP 80% + thumbnail 200px) → MinIO → Ollama Moondream2 (AI tags)
 */

import sharp from 'sharp'
import { Injectable, Logger } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue, Worker, Job } from 'bullmq'
import { MinioService } from './minio.service'
import { OllamaService } from './ollama.service'
import { PrismaService } from '../database/prisma.service'
import * as crypto from 'crypto'

const IMAGE_QUEUE = 'image-processing'

export interface ProcessImageJob {
  photoId: string
  rawStorageKey: string       // temp raw upload key in MinIO
  projectId: string
  roomId: string
  originalFilename: string
  mimeType: string
}

@Injectable()
export class ImageProcessingService {
  private readonly logger = new Logger(ImageProcessingService.name)

  // Compression targets
  private readonly WEBP_QUALITY = 80
  private readonly THUMBNAIL_SIZE = 200
  private readonly MAX_DIMENSION = 2400  // px — preserve detail for insurance reports

  constructor(
    @InjectQueue(IMAGE_QUEUE) private readonly queue: Queue,
    private readonly minio: MinioService,
    private readonly ollama: OllamaService,
    private readonly prisma: PrismaService,
  ) {
    this.startWorker()
  }

  /**
   * Queue a raw upload for processing
   */
  async enqueueProcessing(data: ProcessImageJob): Promise<void> {
    await this.queue.add('process-image', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      priority: 1, // images are high priority
    })
  }

  /**
   * Process a single image through the full pipeline
   */
  async processImage(job: ProcessImageJob): Promise<{
    storageKey: string
    thumbnailKey: string
    width: number
    height: number
    fileSizeBytes: number
    aiTags: string[]
    aiCaption: string | null
  }> {
    this.logger.log(`Processing image ${job.photoId}`)

    // 1. Download raw upload from MinIO temp bucket
    const rawBuffer = await this.minio.download(job.rawStorageKey)

    // 2. Extract EXIF metadata before processing
    const metadata = await sharp(rawBuffer).metadata()
    const originalWidth = metadata.width || 0
    const originalHeight = metadata.height || 0

    // 3. Process main image → WebP
    const mainImageBuffer = await sharp(rawBuffer)
      .rotate()                                          // Auto-rotate from EXIF
      .resize({
        width: this.MAX_DIMENSION,
        height: this.MAX_DIMENSION,
        fit: 'inside',                                   // Never upscale
        withoutEnlargement: true,
      })
      .webp({
        quality: this.WEBP_QUALITY,
        effort: 4,                                       // Balance speed/compression
        smartSubsample: true,
      })
      .toBuffer()

    // 4. Process thumbnail → small WebP
    const thumbnailBuffer = await sharp(rawBuffer)
      .rotate()
      .resize({
        width: this.THUMBNAIL_SIZE,
        height: this.THUMBNAIL_SIZE,
        fit: 'cover',
        position: 'centre',
      })
      .webp({ quality: 70, effort: 3 })
      .toBuffer()

    // 5. Get final dimensions
    const finalMeta = await sharp(mainImageBuffer).metadata()

    // 6. Generate storage keys
    const hash = crypto.createHash('md5').update(rawBuffer).digest('hex').slice(0, 8)
    const storageKey = `photos/${job.projectId}/${job.roomId}/${job.photoId}_${hash}.webp`
    const thumbnailKey = `thumbs/${job.projectId}/${job.roomId}/${job.photoId}_${hash}_thumb.webp`

    // 7. Upload to MinIO
    await Promise.all([
      this.minio.uploadBuffer(storageKey, mainImageBuffer, 'image/webp', {
        'x-restoraflow-photo-id': job.photoId,
        'x-restoraflow-original-name': job.originalFilename,
        'x-restoraflow-processed-at': new Date().toISOString(),
      }),
      this.minio.uploadBuffer(thumbnailKey, thumbnailBuffer, 'image/webp'),
    ])

    // 8. Delete temp raw file
    await this.minio.delete(job.rawStorageKey)

    this.logger.log(`Image ${job.photoId} compressed: ${rawBuffer.length} → ${mainImageBuffer.length} bytes (${Math.round((1 - mainImageBuffer.length / rawBuffer.length) * 100)}% reduction)`)

    // 9. AI Vision tagging with Moondream2 (async, non-blocking)
    let aiTags: string[] = []
    let aiCaption: string | null = null
    try {
      const aiResult = await this.ollama.analyzeImage(thumbnailBuffer, {
        prompt: `You are analyzing a photo from a property damage restoration job.
Describe what damage you see in 1-2 concise sentences suitable for an insurance report.
Then on a new line, list relevant damage tags from: structural, electrical, cosmetic, mold, water_intrusion, smoke, debris, sewage.
Format: DESCRIPTION: <text>\nTAGS: <comma-separated tags>`,
        model: 'moondream',
      })

      // Parse response
      const descMatch = aiResult.match(/DESCRIPTION:\s*(.+)/i)
      const tagsMatch = aiResult.match(/TAGS:\s*(.+)/i)
      aiCaption = descMatch?.[1]?.trim() || null
      aiTags = tagsMatch?.[1]?.split(',').map(t => t.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean) || []
    } catch (err) {
      this.logger.warn(`Moondream2 tagging failed for ${job.photoId}: ${err}`)
    }

    return {
      storageKey,
      thumbnailKey,
      width: finalMeta.width || originalWidth,
      height: finalMeta.height || originalHeight,
      fileSizeBytes: mainImageBuffer.length,
      aiTags,
      aiCaption,
    }
  }

  /**
   * Start the BullMQ worker
   */
  private startWorker() {
    const worker = new Worker<ProcessImageJob>(
      IMAGE_QUEUE,
      async (job: Job<ProcessImageJob>) => {
        const result = await this.processImage(job.data)

        // Update Photo record in DB
        await this.prisma.photo.update({
          where: { id: job.data.photoId },
          data: {
            storageKey: result.storageKey,
            thumbnailKey: result.thumbnailKey,
            width: result.width,
            height: result.height,
            fileSizeBytes: result.fileSizeBytes,
            damageTags: result.aiTags,
            aiCaption: result.aiCaption,
            aiCaptionModelVersion: 'moondream-2',
          },
        })

        return result
      },
      {
        connection: { host: process.env.REDIS_HOST || 'redis', port: 6379 },
        concurrency: 4,   // process 4 images simultaneously
      }
    )

    worker.on('completed', (job) => this.logger.log(`✓ Image ${job.data.photoId} processed`))
    worker.on('failed', (job, err) => this.logger.error(`✗ Image ${job?.data.photoId} failed: ${err.message}`))
  }
}

// ─── Ollama Vision Service ────────────────────────────────────

@Injectable()
export class OllamaService {
  private readonly logger = new Logger(OllamaService.name)
  private readonly baseUrl = process.env.OLLAMA_BASE_URL || 'http://ollama:11434'

  /**
   * Generate AI narrative from technician notes using Llama3
   */
  async generateNarrative(notes: string, context: {
    roomType: string
    damageType: string
    moistureLevel?: number
    damageScore?: number
  }): Promise<string> {
    const prompt = `You are a professional restoration technician writing an insurance damage assessment report.
Transform these raw field notes into a professional 2-3 sentence paragraph suitable for insurance documentation.
Use precise, technical language. Avoid vague terms. Reference specific materials and measurements when mentioned.
Maintain IICRC terminology standards.

Room: ${context.roomType}
Damage Type: ${context.damageType}
${context.moistureLevel ? `Moisture Content: ${context.moistureLevel}%` : ''}
${context.damageScore ? `Damage Score: ${context.damageScore}/10` : ''}

Field Notes: ${notes}

Professional Assessment:`

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_NARRATIVE_MODEL || 'llama3',
        prompt,
        stream: false,
        options: { temperature: 0.3, top_p: 0.9, num_predict: 200 },
      }),
    })

    if (!response.ok) throw new Error(`Ollama error: ${response.status}`)
    const data = await response.json()
    return data.response?.trim() || notes
  }

  /**
   * Analyze image with Moondream2 vision model
   */
  async analyzeImage(imageBuffer: Buffer, { prompt, model }: { prompt: string; model: string }): Promise<string> {
    const base64Image = imageBuffer.toString('base64')
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        images: [base64Image],
        stream: false,
        options: { temperature: 0.2 },
      }),
    })

    if (!response.ok) throw new Error(`Moondream error: ${response.status}`)
    const data = await response.json()
    return data.response?.trim() || ''
  }
}
