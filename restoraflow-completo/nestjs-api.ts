/**
 * RestoraFlow v5 — NestJS Clean Architecture API
 * 
 * Structure:
 *   src/
 *     core/            → Domain entities, ports (interfaces), use cases
 *     infrastructure/  → DB, storage, queues, external adapters
 *     application/     → NestJS modules, controllers, DTOs
 *     shared/          → Guards, decorators, filters, interceptors
 * 
 * Principles:
 *   - Dependencies point inward (Core has zero external deps)
 *   - Use cases are framework-agnostic plain TypeScript classes
 *   - Controllers are thin — delegate immediately to use cases
 *   - All I/O validated with class-validator DTOs at boundary
 */

// ═══════════════════════════════════════════════════════════
// src/core/entities/project.entity.ts
// ═══════════════════════════════════════════════════════════

export type ProjectStatus = 'assessment' | 'active' | 'pending_review' | 'completed' | 'archived'
export type Priority = 'emergency' | 'high' | 'medium' | 'low'
export type ProjectType = 'water_damage' | 'fire_damage' | 'mold_remediation' | 'storm_damage' | 'biohazard'

export class ProjectEntity {
  constructor(
    public readonly id: string,
    public readonly companyId: string,
    public name: string,
    public status: ProjectStatus,
    public priority: Priority,
    public type: ProjectType,
    public estimatedValue: number,
    public createdAt: Date,
    public updatedAt: Date,
  ) {}

  isActive(): boolean { return this.status === 'active' }
  isEmergency(): boolean { return this.priority === 'emergency' }
  canGenerateReport(): boolean { return this.status !== 'assessment' }

  advance(): ProjectStatus {
    const flow: Record<ProjectStatus, ProjectStatus> = {
      assessment: 'active', active: 'pending_review',
      pending_review: 'completed', completed: 'archived', archived: 'archived',
    }
    return flow[this.status]
  }
}

// ═══════════════════════════════════════════════════════════
// src/core/ports/project.repository.ts
// ═══════════════════════════════════════════════════════════

export interface IProjectRepository {
  findById(id: string): Promise<ProjectEntity | null>
  findByCompany(companyId: string, filters?: ProjectFilters): Promise<PaginatedResult<ProjectEntity>>
  save(project: ProjectEntity): Promise<ProjectEntity>
  update(id: string, data: Partial<ProjectEntity>): Promise<ProjectEntity>
  delete(id: string): Promise<void>
}

export interface ProjectFilters {
  status?: ProjectStatus; priority?: Priority; type?: ProjectType
  search?: string; assignedTo?: string; page?: number; limit?: number
}

export interface PaginatedResult<T> {
  data: T[]; total: number; page: number; limit: number; totalPages: number
}

// ═══════════════════════════════════════════════════════════
// src/core/ports/storage.port.ts
// ═══════════════════════════════════════════════════════════

export interface IStoragePort {
  upload(key: string, buffer: Buffer, mimeType: string, metadata?: Record<string, string>): Promise<string>
  download(key: string): Promise<Buffer>
  getPresignedUrl(key: string, expiresInSeconds: number): Promise<string>
  getPresignedUploadUrl(key: string, mimeType: string): Promise<{ url: string; fields: Record<string, string> }>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
}

// ═══════════════════════════════════════════════════════════
// src/core/ports/ai.port.ts
// ═══════════════════════════════════════════════════════════

export interface IAIPort {
  generateNarrative(input: NarrativeInput): Promise<string>
  analyzeImage(buffer: Buffer): Promise<ImageAnalysisResult>
  extractText(buffer: Buffer): Promise<string>
}

export interface NarrativeInput {
  roomType: string; damageType: string; fieldNotes: string
  moistureLevel?: number; damageScore?: number; photos?: string[]
}

export interface ImageAnalysisResult {
  caption: string; damageTags: string[]; severity: number; confidence: number
}

// ═══════════════════════════════════════════════════════════
// src/core/use-cases/create-project.usecase.ts
// ═══════════════════════════════════════════════════════════

import { Injectable, Inject } from '@nestjs/common'
import { IProjectRepository } from '../ports/project.repository'
import { IEventBus } from '../ports/event-bus.port'
import { ProjectEntity } from '../entities/project.entity'
import { ProjectCreatedEvent } from '../events/project-created.event'
import { v4 as uuid } from 'uuid'

export interface CreateProjectCommand {
  companyId: string; name: string; type: ProjectType; priority: Priority
  clientName: string; clientPhone?: string; clientEmail?: string
  propertyAddress: string; propertyType: string
  estimatedValue?: number; notes?: string
  claimNumber?: string; insuranceCompany?: string
  leadTechnicianId?: string; createdById: string
}

@Injectable()
export class CreateProjectUseCase {
  constructor(
    @Inject('IProjectRepository') private readonly projects: IProjectRepository,
    @Inject('IEventBus') private readonly events: IEventBus,
  ) {}

  async execute(cmd: CreateProjectCommand): Promise<ProjectEntity> {
    const project = new ProjectEntity(
      uuid(), cmd.companyId, cmd.name,
      'assessment',     // always starts at assessment
      cmd.priority || 'medium',
      cmd.type,
      cmd.estimatedValue || 0,
      new Date(), new Date(),
    )

    const saved = await this.projects.save(project)

    // Emit domain event — picked up by notification, audit log, socket services
    await this.events.publish(new ProjectCreatedEvent(saved.id, cmd.companyId, cmd.createdById, cmd.priority))

    return saved
  }
}

// ═══════════════════════════════════════════════════════════
// src/core/use-cases/generate-report.usecase.ts
// ═══════════════════════════════════════════════════════════

export interface GenerateReportCommand {
  projectId: string; companyId: string; requestedById: string
  reportType: 'full' | 'photo_log' | 'executive_summary'
  options?: { watermark?: string; includeAiNarratives?: boolean }
}

@Injectable()
export class GenerateReportUseCase {
  constructor(
    @Inject('IProjectRepository') private readonly projects: IProjectRepository,
    @Inject('IPdfQueue') private readonly pdfQueue: IPdfQueue,
    @Inject('IActivityLog') private readonly activity: IActivityLog,
  ) {}

  async execute(cmd: GenerateReportCommand): Promise<{ jobId: string }> {
    const project = await this.projects.findById(cmd.projectId)
    if (!project) throw new Error(`Project ${cmd.projectId} not found`)
    if (!project.canGenerateReport()) throw new Error('Project must be past assessment stage')

    const jobId = await this.pdfQueue.enqueue({
      projectId: cmd.projectId, companyId: cmd.companyId,
      requestedById: cmd.requestedById, reportType: cmd.reportType,
      options: cmd.options || {},
    })

    await this.activity.log({
      companyId: cmd.companyId, userId: cmd.requestedById, projectId: cmd.projectId,
      action: 'report.generation_requested', metadata: { jobId, reportType: cmd.reportType },
    })

    return { jobId }
  }
}

// ═══════════════════════════════════════════════════════════
// src/infrastructure/database/prisma-project.repository.ts
// ═══════════════════════════════════════════════════════════

import { PrismaService } from './prisma.service'
import { IProjectRepository, ProjectFilters, PaginatedResult } from '../../core/ports/project.repository'

@Injectable()
export class PrismaProjectRepository implements IProjectRepository {
  constructor(private readonly prisma: PrismaService) {}

  private toEntity(raw: any): ProjectEntity {
    return new ProjectEntity(raw.id, raw.companyId, raw.name, raw.status,
      raw.priority, raw.type, Number(raw.estimatedValue), raw.createdAt, raw.updatedAt)
  }

  async findById(id: string): Promise<ProjectEntity | null> {
    const raw = await this.prisma.project.findUnique({ where: { id } })
    return raw ? this.toEntity(raw) : null
  }

  async findByCompany(companyId: string, filters: ProjectFilters = {}): Promise<PaginatedResult<ProjectEntity>> {
    const { status, priority, type, search, page = 1, limit = 25 } = filters
    const where: any = { companyId, ...(status && { status }), ...(priority && { priority }), ...(type && { type }) }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { clientName: { contains: search, mode: 'insensitive' } },
        { claimNumber: { contains: search, mode: 'insensitive' } },
        { propertyAddress: { contains: search, mode: 'insensitive' } },
      ]
    }
    const [data, total] = await Promise.all([
      this.prisma.project.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { updatedAt: 'desc' } }),
      this.prisma.project.count({ where }),
    ])
    return { data: data.map(this.toEntity.bind(this)), total, page, limit, totalPages: Math.ceil(total / limit) }
  }

  async save(project: ProjectEntity): Promise<ProjectEntity> {
    const raw = await this.prisma.project.create({
      data: {
        id: project.id, companyId: project.companyId, name: project.name,
        status: project.status as any, priority: project.priority as any, type: project.type as any,
        slug: project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36),
        propertyAddress: '', estimatedValue: project.estimatedValue,
      },
    })
    return this.toEntity(raw)
  }

  async update(id: string, data: Partial<ProjectEntity>): Promise<ProjectEntity> {
    const raw = await this.prisma.project.update({ where: { id }, data: { ...data, updatedAt: new Date() } as any })
    return this.toEntity(raw)
  }

  async delete(id: string): Promise<void> {
    await this.prisma.project.delete({ where: { id } })
  }
}

// ═══════════════════════════════════════════════════════════
// src/application/projects/projects.controller.ts
// ═══════════════════════════════════════════════════════════

import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, HttpStatus } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger'
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard'
import { CompanyGuard } from '../../shared/guards/company.guard'
import { CurrentUser } from '../../shared/decorators/current-user.decorator'
import { CreateProjectUseCase } from '../../core/use-cases/create-project.usecase'
import { GetProjectsUseCase } from '../../core/use-cases/get-projects.usecase'
import { UpdateProjectUseCase } from '../../core/use-cases/update-project.usecase'
import { DeleteProjectUseCase } from '../../core/use-cases/delete-project.usecase'
import { GenerateReportUseCase } from '../../core/use-cases/generate-report.usecase'
import { CreateProjectDto } from './dto/create-project.dto'
import { UpdateProjectDto } from './dto/update-project.dto'
import { ProjectListQueryDto } from './dto/project-list-query.dto'

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard)
@Controller('api/v1/companies/:companyId/projects')
export class ProjectsController {
  constructor(
    private readonly createProject: CreateProjectUseCase,
    private readonly getProjects: GetProjectsUseCase,
    private readonly updateProject: UpdateProjectUseCase,
    private readonly deleteProject: DeleteProjectUseCase,
    private readonly generateReport: GenerateReportUseCase,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List projects with filters & pagination' })
  async list(@Param('companyId') companyId: string, @Query() query: ProjectListQueryDto) {
    return this.getProjects.execute({ companyId, ...query })
  }

  @Post()
  @ApiOperation({ summary: 'Create a new project' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Project created successfully' })
  async create(
    @Param('companyId') companyId: string,
    @Body() dto: CreateProjectDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.createProject.execute({ ...dto, companyId, createdById: user.id })
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get project with full relations' })
  async findOne(@Param('companyId') companyId: string, @Param('id') id: string) {
    return this.getProjects.executeOne({ companyId, projectId: id })
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update project fields' })
  async update(@Param('id') id: string, @Body() dto: UpdateProjectDto, @CurrentUser() user: { id: string }) {
    return this.updateProject.execute({ projectId: id, data: dto, updatedById: user.id })
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Archive project (soft delete)' })
  async remove(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.deleteProject.execute({ projectId: id, deletedById: user.id })
  }

  @Post(':id/generate-report')
  @ApiOperation({ summary: 'Enqueue PDF report generation job' })
  async report(
    @Param('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: { reportType?: string; watermark?: string },
    @CurrentUser() user: { id: string },
  ) {
    return this.generateReport.execute({
      projectId: id, companyId, requestedById: user.id,
      reportType: (body.reportType || 'full') as any,
      options: { watermark: body.watermark },
    })
  }

  @Post(':id/advance-status')
  @ApiOperation({ summary: 'Advance project to next workflow status' })
  async advance(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.updateProject.advanceStatus({ projectId: id, userId: user.id })
  }
}

// ═══════════════════════════════════════════════════════════
// src/application/projects/dto/create-project.dto.ts
// ═══════════════════════════════════════════════════════════

import { IsString, IsEnum, IsOptional, IsNumber, IsEmail, IsPhoneNumber, Length, Min, Max } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Transform } from 'class-transformer'

export class CreateProjectDto {
  @ApiProperty({ example: 'Smith Residence — Water Damage' })
  @IsString() @Length(3, 120) name: string

  @ApiProperty({ enum: ['water_damage', 'fire_damage', 'mold_remediation', 'storm_damage', 'biohazard'] })
  @IsEnum(['water_damage', 'fire_damage', 'mold_remediation', 'storm_damage', 'biohazard']) type: string

  @ApiProperty({ enum: ['emergency', 'high', 'medium', 'low'] })
  @IsEnum(['emergency', 'high', 'medium', 'low']) priority: string

  @ApiProperty({ example: 'Sarah & Tom Hendricks' })
  @IsString() @Length(2, 100) clientName: string

  @ApiPropertyOptional() @IsOptional() @IsEmail() clientEmail?: string
  @ApiPropertyOptional() @IsOptional() @IsString() clientPhone?: string

  @ApiProperty({ example: '2847 Maple Grove Drive, Plano TX 75023' })
  @IsString() @Length(10, 200) propertyAddress: string

  @ApiPropertyOptional({ enum: ['residential', 'commercial', 'multi_family', 'industrial'] })
  @IsOptional() @IsEnum(['residential', 'commercial', 'multi_family', 'industrial']) propertyType?: string

  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Transform(({ value }) => Number(value))
  estimatedValue?: number

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string
  @ApiPropertyOptional() @IsOptional() @IsString() claimNumber?: string
  @ApiPropertyOptional() @IsOptional() @IsString() insuranceCompany?: string
  @ApiPropertyOptional() @IsOptional() @IsString() leadTechnicianId?: string
}

// ═══════════════════════════════════════════════════════════
// src/application/app.module.ts
// ═══════════════════════════════════════════════════════════

import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ThrottlerModule } from '@nestjs/throttler'
import { BullModule } from '@nestjs/bullmq'
import { ScheduleModule } from '@nestjs/schedule'
import { ProjectsModule } from './projects/projects.module'
import { PhotosModule } from './photos/photos.module'
import { AuthModule } from './auth/auth.module'
import { ReportsModule } from './reports/reports.module'
import { WebsocketsModule } from './websockets/websockets.module'
import { SyncModule } from './sync/sync.module'
import { DatabaseModule } from '../infrastructure/database/database.module'
import { StorageModule } from '../infrastructure/storage/storage.module'
import { AIModule } from '../infrastructure/ai/ai.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 200 }]),
    BullModule.forRoot({ connection: { host: process.env.REDIS_HOST || 'redis', port: 6379 } }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    StorageModule,
    AIModule,
    AuthModule,
    ProjectsModule,
    PhotosModule,
    ReportsModule,
    WebsocketsModule,
    SyncModule,
  ],
})
export class AppModule {}

// ═══════════════════════════════════════════════════════════
// src/application/websockets/events.gateway.ts
// ═══════════════════════════════════════════════════════════

import { WebSocketGateway, WebSocketServer, SubscribeMessage, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { UseGuards } from '@nestjs/common'
import { WsJwtGuard } from '../../shared/guards/ws-jwt.guard'

@WebSocketGateway({ cors: { origin: process.env.CORS_ORIGINS?.split(',') || '*' }, namespace: '/realtime' })
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server

  handleConnection(client: Socket) {
    const companyId = client.handshake.auth?.companyId
    if (companyId) client.join(`company:${companyId}`)
    console.log(`WS client connected: ${client.id}`)
  }

  handleDisconnect(client: Socket) {
    console.log(`WS client disconnected: ${client.id}`)
  }

  // Emit to all clients in a company room
  emitToCompany(companyId: string, event: string, data: any) {
    this.server.to(`company:${companyId}`).emit(event, data)
  }

  // Real-time project updates
  notifyProjectUpdate(companyId: string, projectId: string, changes: any) {
    this.emitToCompany(companyId, 'project:updated', { projectId, changes, timestamp: new Date() })
  }

  // Photo sync complete
  notifyPhotoSynced(companyId: string, photo: { id: string; roomId: string; url: string }) {
    this.emitToCompany(companyId, 'photo:synced', { ...photo, timestamp: new Date() })
  }

  // Moisture alert threshold
  notifyMoistureAlert(companyId: string, data: { projectId: string; roomId: string; value: number; threshold: number }) {
    this.emitToCompany(companyId, 'moisture:alert', { ...data, timestamp: new Date() })
  }

  // Report ready
  notifyReportReady(companyId: string, data: { projectId: string; reportUrl: string; reportId: string }) {
    this.emitToCompany(companyId, 'report:ready', { ...data, timestamp: new Date() })
  }

  @SubscribeMessage('join:project')
  handleJoinProject(client: Socket, projectId: string) {
    client.join(`project:${projectId}`)
  }
}

// ═══════════════════════════════════════════════════════════
// src/shared/guards/jwt-auth.guard.ts
// ═══════════════════════════════════════════════════════════

import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { AuthGuard } from '@nestjs/passport'

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private jwtService: JwtService) { super() }

  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest()
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) throw new UnauthorizedException('Missing authentication token')
    try {
      req.user = this.jwtService.verify(token, { secret: process.env.JWT_SECRET })
      return true
    } catch {
      throw new UnauthorizedException('Invalid or expired token')
    }
  }
}

// ═══════════════════════════════════════════════════════════
// src/main.ts — Bootstrap
// ═══════════════════════════════════════════════════════════

import { NestFactory } from '@nestjs/core'
import { ValidationPipe, VersioningType } from '@nestjs/common'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import { IoAdapter } from '@nestjs/platform-socket.io'
import compression from 'compression'
import helmet from 'helmet'
import { AppModule } from './application/app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] })

  // Security
  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(compression())
  app.enableCors({ origin: process.env.CORS_ORIGINS?.split(',') || 'http://localhost:3000', credentials: true })

  // Validation — strict at boundary
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, forbidNonWhitelisted: true, transform: true,
    transformOptions: { enableImplicitConversion: true },
  }))

  // API versioning
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })

  // WebSockets
  app.useWebSocketAdapter(new IoAdapter(app))

  // Swagger docs
  const config = new DocumentBuilder()
    .setTitle('RestoraFlow API')
    .setDescription('Property restoration field documentation platform')
    .setVersion('5.0.0')
    .addBearerAuth()
    .addServer(process.env.API_URL || 'http://localhost:3001')
    .build()
  const doc = SwaggerModule.createDocument(app, config)
  SwaggerModule.setup('api/docs', app, doc, {
    swaggerOptions: { persistAuthorization: true },
    customSiteTitle: 'RestoraFlow API Docs',
  })

  // Health check
  app.getHttpAdapter().get('/health', (_, res) => res.json({ status: 'ok', version: '5.0.0', timestamp: new Date() }))

  const port = process.env.PORT || 3001
  await app.listen(port)
  console.log(`🚀 RestoraFlow API running on :${port}`)
  console.log(`📖 Swagger docs at :${port}/api/docs`)
}

bootstrap()
