import type { FastifyRequest } from "fastify";
import { HttpError, badRequest } from "./errors.ts";

export interface UploadedFile {
  name: string;
  bytes: Buffer;
  mimeType: string;
}

/** The files of a multipart request, each read whole: uploads are small by configuration. */
export async function uploaded(req: FastifyRequest): Promise<UploadedFile[]> {
  if (!req.isMultipart()) throw badRequest("send the file as multipart/form-data");
  const files: UploadedFile[] = [];
  try {
    for await (const part of req.files())
      files.push({ name: part.filename, bytes: await part.toBuffer(), mimeType: part.mimetype });
  } catch (err) {
    if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE")
      throw new HttpError(413, "file_too_large", "that file is larger than this server accepts");
    throw err;
  }
  if (files.length === 0) throw badRequest("no file was sent");
  return files;
}
