import { z } from "zod";

export const ErrorTypeSchema = z.enum([
  "exception",
  "error_code",
  "console",
  "panic",
  "assert",
  "custom_class",
]);

export const SeveritySchema = z.enum(["critical", "error", "warning", "info"]);

export const ExtractedErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  type: ErrorTypeSchema,
  file: z.string(),
  line: z.number().int().positive().optional(),
  context: z.string().optional(),
  cause: z.string().optional(),
  resolution: z.string().optional(),
  severity: SeveritySchema.optional(),
  httpStatus: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
});

export const RepoInfoSchema = z.object({
  name: z.string(),
  owner: z.string().optional(),
  language: z.string(),
  version: z.string().optional(),
});

export const AnalysisMetadataSchema = z.object({
  filesScanned: z.number().int().optional(),
  analysisVersion: z.string().optional(),
  timestamp: z.string().datetime().optional(),
});

export const AnalysisResultSchema = z.object({
  repo: RepoInfoSchema,
  errors: z.array(ExtractedErrorSchema),
  metadata: AnalysisMetadataSchema.optional(),
});

export type ErrorType = z.infer<typeof ErrorTypeSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type ExtractedError = z.infer<typeof ExtractedErrorSchema>;
export type RepoInfo = z.infer<typeof RepoInfoSchema>;
export type AnalysisMetadata = z.infer<typeof AnalysisMetadataSchema>;
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export function validateAnalysisResult(data: unknown): AnalysisResult {
  return AnalysisResultSchema.parse(data);
}

export function safeValidateAnalysisResult(
  data: unknown
): { success: true; data: AnalysisResult } | { success: false; error: z.ZodError } {
  const result = AnalysisResultSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
