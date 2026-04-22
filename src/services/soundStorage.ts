/**
 * Storage de sons de KPI via Cloudflare R2 (S3-compatible).
 *
 * Espelha o padrão de `photoStorage.ts` — mesma infra R2, só muda o prefixo
 * (`sounds/` em vez de `assessors/`) e o Content-Type.
 *
 * Introduzido 22/04/2026 com o modelo `KpiSound` pra permitir admin upar
 * MP3/WAV por KPI e tocar via SSE broadcast, em vez de synth hardcoded +
 * arquivo estático no frontend (arquitetura anterior que causava double-play).
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../env.js";

export interface SoundStorage {
  /**
   * Grava o arquivo de som de um KPI e retorna a URL pública a ser
   * persistida em `KpiSound.soundUrl`. A extensão é derivada do mime
   * (ex: audio/mpeg → .mp3, audio/wav → .wav).
   */
  uploadKpiSound(kpiId: string, buffer: Buffer, mimeType: string): Promise<string>;
  /** Remove o som de um KPI (best-effort — ignora erros de "not found"). */
  deleteKpiSound(kpiId: string): Promise<void>;
}

function mimeToExtension(mime: string): string {
  // MIME types aceitos pelo upload de som. Mantém lista curta — admin não
  // precisa de formatos exóticos.
  const normalized = mime.toLowerCase();
  if (normalized === "audio/mpeg" || normalized === "audio/mp3") return "mp3";
  if (normalized === "audio/wav" || normalized === "audio/x-wav") return "wav";
  if (normalized === "audio/ogg") return "ogg";
  if (normalized === "audio/webm") return "webm";
  // Default pra mp3 — maior compat cross-browser
  return "mp3";
}

class R2SoundStorage implements SoundStorage {
  private client: S3Client;
  private bucket: string;
  private publicUrl: string;

  constructor(params: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicUrl: string;
    endpoint?: string;
  }) {
    const endpoint =
      params.endpoint ?? `https://${params.accountId}.r2.cloudflarestorage.com`;
    this.client = new S3Client({
      region: "auto",
      endpoint,
      credentials: {
        accessKeyId: params.accessKeyId,
        secretAccessKey: params.secretAccessKey,
      },
    });
    this.bucket = params.bucket;
    this.publicUrl = params.publicUrl.replace(/\/$/, "");
  }

  async uploadKpiSound(kpiId: string, buffer: Buffer, mimeType: string): Promise<string> {
    const ext = mimeToExtension(mimeType);
    const key = `sounds/${kpiId}.${ext}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        // Cache maior que foto — som não muda com frequência, e o cache-bust
        // no query string força refresh quando admin sobe novo arquivo.
        CacheControl: "public, max-age=3600",
      }),
    );
    return `${this.publicUrl}/${key}?v=${Date.now()}`;
  }

  async deleteKpiSound(kpiId: string): Promise<void> {
    // Tenta deletar todas extensões comuns — admin pode ter subido mp3 e
    // depois wav, por exemplo. Best-effort, ignora "not found".
    for (const ext of ["mp3", "wav", "ogg", "webm"]) {
      try {
        await this.client.send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: `sounds/${kpiId}.${ext}`,
          }),
        );
      } catch {
        // Ignorar
      }
    }
  }
}

let cachedStorage: SoundStorage | null = null;

export function getSoundStorage(): SoundStorage {
  if (cachedStorage) return cachedStorage;

  if (
    !env.R2_BUCKET ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.R2_ACCOUNT_ID ||
    !env.R2_PUBLIC_URL
  ) {
    throw new Error(
      "R2 storage não configurado. Defina R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, " +
        "R2_SECRET_ACCESS_KEY, R2_BUCKET e R2_PUBLIC_URL no .env.",
    );
  }

  cachedStorage = new R2SoundStorage({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    publicUrl: env.R2_PUBLIC_URL,
    endpoint: env.R2_ENDPOINT,
  });
  return cachedStorage;
}

/** Usado em testes pra forçar recriar o client após mudar env. */
export function resetSoundStorage(): void {
  cachedStorage = null;
}
