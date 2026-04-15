/**
 * RestoraFlow v5 — Offline-First PWA Sync Strategy
 * 
 * Architecture:
 *   1. Dexie.js (IndexedDB) as local database
 *   2. All writes go to local DB first → immediate UI update
 *   3. Background sync queue uploads to server when online
 *   4. Conflict resolution: server wins for project metadata, last-write-wins for field docs
 *   5. Service Worker (Workbox) caches API responses for offline reads
 */

import Dexie, { Table } from 'dexie'
import type { Project, Room, Photo, MoistureLog } from '@/types'

// ─── Local Database Schema ───────────────────────────────────

interface LocalProject extends Project {
  _dirty: boolean     // needs sync
  _localCreated: boolean  // created offline, no server ID yet
  _deletedAt?: string
}

interface LocalPhoto {
  id: string
  roomId: string
  projectId: string
  localFileBlob?: Blob  // raw file before upload to MinIO
  uploadedUrl?: string  // MinIO URL after successful upload
  caption: string
  damageTags: string[]
  moistureLevel?: number
  takenAt: string
  geoLat?: number
  geoLng?: number
  category: string
  syncStatus: 'pending' | 'uploading' | 'synced' | 'failed'
  retries: number
}

interface SyncQueueItem {
  id?: number           // auto-increment
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'UPLOAD_PHOTO' | 'LOG_MOISTURE'
  entityType: 'project' | 'room' | 'photo' | 'moisture_log' | 'floor_pin'
  localId: string
  serverId?: string
  payload: any
  timestamp: string
  retries: number
  lastError?: string
  priority: number      // 1=high (photos/moisture), 5=low (notes)
}

class RestoraFlowDB extends Dexie {
  projects!: Table<LocalProject>
  rooms!: Table<Room>
  photos!: Table<LocalPhoto>
  moistureLogs!: Table<MoistureLog>
  syncQueue!: Table<SyncQueueItem>
  serverCache!: Table<{ key: string; data: any; cachedAt: string; ttl: number }>

  constructor() {
    super('RestoraFlowDB')
    this.version(1).stores({
      projects: 'id, status, priority, updatedAt, _dirty, companyId',
      rooms: 'id, projectId, type, createdAt',
      photos: 'id, roomId, projectId, syncStatus, takenAt',
      moistureLogs: 'id, roomId, projectId, readingDate',
      syncQueue: '++id, action, entityType, timestamp, retries, priority',
      serverCache: 'key, cachedAt',
    })
  }
}

export const db = new RestoraFlowDB()

// ─── Sync Engine ─────────────────────────────────────────────

class OfflineSyncEngine {
  private isOnline = navigator.onLine
  private isSyncing = false
  private syncInterval: ReturnType<typeof setInterval> | null = null
  private listeners: Set<(status: SyncStatus) => void> = new Set()

  constructor() {
    window.addEventListener('online', () => this.handleOnline())
    window.addEventListener('offline', () => this.handleOffline())
  }

  get status(): SyncStatus {
    return {
      isOnline: this.isOnline,
      isSyncing: this.isSyncing,
      pendingCount: 0, // populated async
    }
  }

  // ── Event Handlers ────────────────────────────────────────

  private async handleOnline() {
    this.isOnline = true
    this.notify()
    await this.processSyncQueue()
    this.startPeriodicSync()
  }

  private handleOffline() {
    this.isOnline = false
    this.stopPeriodicSync()
    this.notify()
  }

  private startPeriodicSync() {
    this.syncInterval = setInterval(() => this.processSyncQueue(), 30_000)
  }

  private stopPeriodicSync() {
    if (this.syncInterval) clearInterval(this.syncInterval)
  }

  // ── Write Operations (offline-capable) ───────────────────

  /**
   * Create a room locally, queue sync
   */
  async createRoom(room: Omit<Room, 'id'>): Promise<Room> {
    const localRoom: Room = {
      ...room,
      id: `local_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
    }
    await db.rooms.add(localRoom)
    await this.enqueue({
      action: 'CREATE',
      entityType: 'room',
      localId: localRoom.id,
      payload: localRoom,
      priority: 3,
    })
    return localRoom
  }

  /**
   * Upload photo — saves blob locally first, uploads to MinIO when online
   */
  async capturePhoto(data: {
    roomId: string
    projectId: string
    file: File
    caption: string
    damageTags: string[]
    moistureLevel?: number
    geoLat?: number
    geoLng?: number
  }): Promise<LocalPhoto> {
    // Compress locally using Canvas API before storing
    const compressedBlob = await this.compressImage(data.file, 0.8, 1200)

    const localPhoto: LocalPhoto = {
      id: `local_${crypto.randomUUID()}`,
      roomId: data.roomId,
      projectId: data.projectId,
      localFileBlob: compressedBlob,
      caption: data.caption,
      damageTags: data.damageTags,
      moistureLevel: data.moistureLevel,
      takenAt: new Date().toISOString(),
      geoLat: data.geoLat,
      geoLng: data.geoLng,
      category: 'damage',
      syncStatus: 'pending',
      retries: 0,
    }

    await db.photos.add(localPhoto)

    // High priority — photos are core data
    await this.enqueue({
      action: 'UPLOAD_PHOTO',
      entityType: 'photo',
      localId: localPhoto.id,
      payload: {
        roomId: data.roomId,
        projectId: data.projectId,
        caption: data.caption,
        damageTags: data.damageTags,
        moistureLevel: data.moistureLevel,
        geoLat: data.geoLat,
        geoLng: data.geoLng,
      },
      priority: 1, // highest priority
    })

    // Attempt immediate upload if online
    if (this.isOnline) {
      this.processPhotoUpload(localPhoto.id).catch(console.error)
    }

    return localPhoto
  }

  /**
   * Log moisture reading locally
   */
  async logMoisture(data: Omit<MoistureLog, 'id'>): Promise<MoistureLog> {
    const log: MoistureLog = {
      ...data,
      id: `local_${crypto.randomUUID()}`,
      date: new Date().toISOString(),
    }
    await db.moistureLogs.add(log)
    await this.enqueue({
      action: 'LOG_MOISTURE',
      entityType: 'moisture_log',
      localId: log.id,
      payload: log,
      priority: 2,
    })
    return log
  }

  /**
   * Update project metadata locally
   */
  async updateProject(id: string, updates: Partial<Project>): Promise<void> {
    await db.projects.update(id, { ...updates, _dirty: true })
    await this.enqueue({
      action: 'UPDATE',
      entityType: 'project',
      localId: id,
      payload: updates,
      priority: 4,
    })
  }

  // ── Sync Queue Processing ─────────────────────────────────

  private async processSyncQueue(): Promise<void> {
    if (this.isSyncing || !this.isOnline) return
    this.isSyncing = true
    this.notify()

    try {
      // Process by priority (1 = highest)
      const items = await db.syncQueue
        .orderBy('priority')
        .filter(item => item.retries < 5)
        .limit(50)
        .toArray()

      for (const item of items) {
        try {
          await this.processItem(item)
          await db.syncQueue.delete(item.id!)
        } catch (error) {
          await db.syncQueue.update(item.id!, {
            retries: item.retries + 1,
            lastError: String(error),
          })
        }
      }

      // Mark synced projects as clean
      await db.projects.where('_dirty').equals(1 as any).modify({ _dirty: false })
    } finally {
      this.isSyncing = false
      this.notify()
    }
  }

  private async processItem(item: SyncQueueItem): Promise<void> {
    const api = (path: string, method: string, body?: any) =>
      fetch(`/api/v1${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.getToken()}` },
        body: body ? JSON.stringify(body) : undefined,
      }).then(r => { if (!r.ok) throw new Error(`API error ${r.status}`); return r.json() })

    switch (item.action) {
      case 'CREATE':
        if (item.entityType === 'room') {
          const res = await api(`/projects/${item.payload.projectId}/rooms`, 'POST', item.payload)
          // Update local ID to server ID
          await db.rooms.where('id').equals(item.localId).modify({ id: res.id })
          await this.logSyncSuccess(item, res.id)
        }
        break

      case 'UPDATE':
        await api(`/${item.entityType}s/${item.localId}`, 'PATCH', item.payload)
        break

      case 'UPLOAD_PHOTO':
        await this.processPhotoUpload(item.localId)
        break

      case 'LOG_MOISTURE':
        const resLog = await api(
          `/rooms/${item.payload.roomId}/moisture-logs`,
          'POST',
          item.payload,
        )
        await db.moistureLogs.where('id').equals(item.localId).modify({ id: resLog.id })
        break

      case 'DELETE':
        await api(`/${item.entityType}s/${item.serverId || item.localId}`, 'DELETE')
        break
    }
  }

  private async processPhotoUpload(localId: string): Promise<void> {
    const photo = await db.photos.get(localId)
    if (!photo?.localFileBlob) return

    await db.photos.update(localId, { syncStatus: 'uploading' })

    // 1. Get pre-signed upload URL from API
    const res = await fetch('/api/v1/photos/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.getToken()}` },
      body: JSON.stringify({ roomId: photo.roomId, mimeType: 'image/webp' }),
    }).then(r => r.json())

    // 2. Upload directly to MinIO
    await fetch(res.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp' },
      body: photo.localFileBlob,
    })

    // 3. Confirm with API (creates Photo record in DB)
    const confirmed = await fetch('/api/v1/photos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.getToken()}` },
      body: JSON.stringify({
        roomId: photo.roomId,
        projectId: photo.projectId,
        storageKey: res.storageKey,
        thumbnailKey: res.thumbnailKey,
        caption: photo.caption,
        damageTags: photo.damageTags,
        moistureReading: photo.moistureLevel,
        geoLat: photo.geoLat,
        geoLng: photo.geoLng,
        takenAt: photo.takenAt,
      }),
    }).then(r => r.json())

    // 4. Update local record — clear blob to save space, mark synced
    await db.photos.update(localId, {
      id: confirmed.id,
      uploadedUrl: confirmed.url,
      localFileBlob: undefined, // free up IndexedDB space
      syncStatus: 'synced',
    })
  }

  // ── Server → Local Sync (pull) ────────────────────────────

  /**
   * Pull latest project data from server (called on app open / resume)
   */
  async pullProjects(): Promise<void> {
    if (!this.isOnline) return
    const res = await fetch('/api/v1/projects?limit=100', {
      headers: { Authorization: `Bearer ${this.getToken()}` },
    }).then(r => r.json())

    await db.transaction('rw', db.projects, async () => {
      for (const project of res.data) {
        const local = await db.projects.get(project.id)
        if (!local || new Date(project.updatedAt) > new Date(local.updatedAt)) {
          await db.projects.put({ ...project, _dirty: false, _localCreated: false })
        }
      }
    })
  }

  // ── Utilities ─────────────────────────────────────────────

  private async enqueue(data: Omit<SyncQueueItem, 'id' | 'timestamp' | 'retries'>): Promise<void> {
    await db.syncQueue.add({
      ...data,
      timestamp: new Date().toISOString(),
      retries: 0,
    })
  }

  private async logSyncSuccess(item: SyncQueueItem, serverId?: string): Promise<void> {
    // Could log to server-side audit trail
    console.debug(`Synced ${item.entityType} ${item.localId} → ${serverId || 'updated'}`)
  }

  private async compressImage(file: File, quality: number, maxWidth: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(url)
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, maxWidth / img.width)
        canvas.width = img.width * scale
        canvas.height = img.height * scale
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Compression failed')), 'image/webp', quality)
      }
      img.onerror = reject
      img.src = url
    })
  }

  private getToken(): string {
    return localStorage.getItem('rf_token') || ''
  }

  // ── Observable Status ─────────────────────────────────────

  subscribe(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async notify(): Promise<void> {
    const pending = await db.syncQueue.count()
    const status: SyncStatus = {
      isOnline: this.isOnline,
      isSyncing: this.isSyncing,
      pendingCount: pending,
    }
    this.listeners.forEach(l => l(status))
  }
}

export interface SyncStatus {
  isOnline: boolean
  isSyncing: boolean
  pendingCount: number
}

// ─── Singleton ───────────────────────────────────────────────

export const syncEngine = new OfflineSyncEngine()

// ─── React Hook ──────────────────────────────────────────────

// import { useState, useEffect } from 'react'
//
// export function useSyncStatus() {
//   const [status, setStatus] = useState<SyncStatus>({ isOnline: navigator.onLine, isSyncing: false, pendingCount: 0 })
//   useEffect(() => {
//     return syncEngine.subscribe(setStatus)
//   }, [])
//   return status
// }

// ─── Service Worker (Workbox) — workbox.config.js ────────────
/*
module.exports = {
  globDirectory: '.next/static',
  globPatterns: ['**\/*.{js,css,html,ico,png,svg,woff2}'],
  swDest: 'public/sw.js',
  runtimeCaching: [
    {
      urlPattern: /\/api\/v1\/projects/,
      handler: 'NetworkFirst',
      options: {
        cacheName: 'api-projects',
        networkTimeoutSeconds: 5,
        expiration: { maxEntries: 100, maxAgeSeconds: 24 * 60 * 60 },
      },
    },
    {
      urlPattern: /\/api\/v1\/photos\/upload-url/,
      handler: 'NetworkOnly', // Never cache upload URLs
    },
    {
      urlPattern: /https:\/\/minio\./,
      handler: 'CacheFirst',
      options: {
        cacheName: 'minio-photos',
        expiration: { maxEntries: 500, maxAgeSeconds: 7 * 24 * 60 * 60 },
      },
    },
  ],
}
*/
