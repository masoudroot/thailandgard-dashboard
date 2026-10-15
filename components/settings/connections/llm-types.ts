/** تایپ‌های مشترک پنل‌های درگاه‌ها و مدل‌های هوش مصنوعی. */

export interface MaskedEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasKey: boolean;
}

export interface TeamModelEntry {
  endpointId: string;
  model: string;
}

export interface EndpointTestResult {
  ok: boolean;
  message: string;
  latencyMs: number | null;
}

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface AutoAssignResult {
  assignments: {
    team: string;
    faName: string;
    endpointId: string;
    endpointName: string;
    model: string;
    reason: string;
  }[];
  skipped: { team: string; faName: string; reason: string }[];
}
