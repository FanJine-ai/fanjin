import { apiGet } from "../../../api/http";
import { apiPostWithStepUp } from "../../../api/stepUp";

export type MediaServiceKind = "mediakit" | "imagex";
export interface MediaService {
  id: string; kind: MediaServiceKind; name: string; enabled: boolean; configured: boolean;
  mode: "generative" | null; requiresConfiguration: boolean; serviceId: string;
  credentialGeneration: number | null; supportedResolutions: string[];
  healthStatus: string | null; lastHealthCheckAt: number | null; updateTime: number;
  acceptNewJobs?: boolean; routingMode?: "active" | "standby" | "draining" | null; healthMessage?: string | null;
}
export interface MediaServiceInput {
  id?: string; kind: MediaServiceKind; name: string; enabled: boolean; expectedUpdateTime?: number;
  apiKey?: string; serviceId?: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string;
  acceptNewJobs?: boolean;
}
export async function listMediaServices(): Promise<MediaService[]> {
  const result = await apiGet<{ services: MediaService[] }>("/admin/mediaServices");
  return result.services;
}
export function saveMediaService(input: MediaServiceInput) {
  return apiPostWithStepUp<MediaService>("/admin/mediaServices/save", { ...input }, "admin.media_service");
}
export interface MediaServiceCheck {
  ok: boolean; message: string; processingVerified?: boolean;
  checks?: { name: string; status: "passed" | "failed" | "unverified"; message: string; code: string | null; requestId: string | null; httpStatus: number | null }[];
}
export function checkMediaService(id: string) {
  return apiPostWithStepUp<MediaServiceCheck>("/admin/mediaServices/check", { id }, "admin.media_service");
}
