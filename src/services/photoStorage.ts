/**
 * Storage de fotos de assessor via Cloudflare R2 (S3-compatible).
 *
 * Sem fallback local: exige R2 configurado (R2_BUCKET, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID, R2_PUBLIC_URL). Em dev local,
 * basta preencher o `.env` com as credenciais do bucket.
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../env.js";

export interface PhotoStorage {
  /** Grava a foto JPEG do assessor e retorna a photoUrl pública a ser persistida no banco. */
  uploadAssessorPhoto(assessorId: string, jpegBuffer: Buffer): Promise<string>;
  /** Remove a foto de um assessor (best-effort — ignora erros de "not found"). */
  deleteAssessorPhoto(assessorId: string): Promise<void>;
}

class R2PhotoStorage implements PhotoStorage {
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

  async uploadAssessorPhoto(assessorId: string, jpegBuffer: Buffer): Promise<string> {
    const key = `assessors/${assessorId}.jpg`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: jpegBuffer,
        ContentType: "image/jpeg",
        CacheControl: "public, max-age=300",
      }),
    );
    // Cache-buster evita navegador servir foto antiga após re-upload.
    return `${this.publicUrl}/${key}?v=${Date.now()}`;
  }

  async deleteAssessorPhoto(assessorId: string): Promise<void> {
    const key = `assessors/${assessorId}.jpg`;
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch {
      // Ignorar — se não existe, ok
    }
  }
}

let cachedStorage: PhotoStorage | null = null;

export function getPhotoStorage(): PhotoStorage {
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

  cachedStorage = new R2PhotoStorage({
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
export function resetPhotoStorage(): void {
  cachedStorage = null;
}
