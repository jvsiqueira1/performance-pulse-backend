/**
 * Storage adapter pra fotos de assessor.
 *
 * Se `R2_BUCKET` estiver configurado, usa Cloudflare R2 (S3-compatible).
 * Caso contrário, cai pra storage local em disco (`UPLOAD_DIR/assessors/*.jpg`).
 * Isso permite dev local sem R2 e prod com R2.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../env.js";

export interface PhotoStorage {
  /** Grava a foto JPEG do assessor e retorna a photoUrl pública a ser persistida no banco. */
  uploadAssessorPhoto(assessorId: string, jpegBuffer: Buffer): Promise<string>;
  /** Remove a foto de um assessor (best-effort — ignora erros de "not found"). */
  deleteAssessorPhoto(assessorId: string): Promise<void>;
}

// ─── Local filesystem implementation ────────────────────────────────────────

class LocalPhotoStorage implements PhotoStorage {
  async uploadAssessorPhoto(assessorId: string, jpegBuffer: Buffer): Promise<string> {
    const uploadRoot = resolve(env.UPLOAD_DIR);
    const assessorsDir = join(uploadRoot, "assessors");
    await mkdir(assessorsDir, { recursive: true });

    const fileName = `${assessorId}.jpg`;
    await writeFile(join(assessorsDir, fileName), jpegBuffer);

    // Cache-buster via query string (Felipe reportou que UI mostrava foto antiga)
    return `/uploads/assessors/${fileName}?v=${Date.now()}`;
  }

  async deleteAssessorPhoto(_assessorId: string): Promise<void> {
    // Local: overwrite já basta, não precisa delete ativo
  }
}

// ─── Cloudflare R2 implementation ───────────────────────────────────────────

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
    this.publicUrl = params.publicUrl.replace(/\/$/, ""); // remove trailing slash
  }

  async uploadAssessorPhoto(assessorId: string, jpegBuffer: Buffer): Promise<string> {
    const key = `assessors/${assessorId}.jpg`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: jpegBuffer,
        ContentType: "image/jpeg",
        // Cache-Control: navegador cacheia por 5min, CDN cacheia mais.
        // Cache-buster via query string na URL evita ver foto antiga.
        CacheControl: "public, max-age=300",
      }),
    );
    return `${this.publicUrl}/${key}?v=${Date.now()}`;
  }

  async deleteAssessorPhoto(assessorId: string): Promise<void> {
    const key = `assessors/${assessorId}.jpg`;
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch {
      // Ignore — se não existe, ok
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

let cachedStorage: PhotoStorage | null = null;

export function getPhotoStorage(): PhotoStorage {
  if (cachedStorage) return cachedStorage;

  const r2Configured =
    env.R2_BUCKET &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY &&
    env.R2_ACCOUNT_ID &&
    env.R2_PUBLIC_URL;

  if (r2Configured) {
    cachedStorage = new R2PhotoStorage({
      accountId: env.R2_ACCOUNT_ID!,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      bucket: env.R2_BUCKET!,
      publicUrl: env.R2_PUBLIC_URL!,
      endpoint: env.R2_ENDPOINT,
    });
  } else {
    cachedStorage = new LocalPhotoStorage();
  }
  return cachedStorage;
}

/** Usado em testes/dev pra forçar recriar o client após mudar env. */
export function resetPhotoStorage(): void {
  cachedStorage = null;
}
