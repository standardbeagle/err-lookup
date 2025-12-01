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

export const ArticleRecommendationSchema = z.object({
  topic: z.string(),
  category: z.string(),
  slug: z.string(),
  relevance: z.string(),
  priority: z.string().optional(),
});

export const SuggestedArticleSchema = z.object({
  title: z.string(),
  category: z.string(),
  description: z.string(),
  relatedErrors: z.array(z.string()).optional(),
});

export const ExtractedErrorSchema = z.object({
  // Core fields
  code: z.string().optional(),
  message: z.string(),
  type: ErrorTypeSchema,
  file: z.string(),
  line: z.number().int().positive().optional(),
  severity: SeveritySchema.optional(),
  httpStatus: z.number().int().optional(),
  tags: z.array(z.string()).optional(),

  // Source code context (for SEO and debugging)
  sourceCode: z.string().optional(),           // The exact line(s) that throw the error
  sourceCodeStart: z.number().int().optional(), // Start line of the code region
  sourceCodeEnd: z.number().int().optional(),   // End line of the code region
  githubUrl: z.string().url().optional(),       // Direct link to GitHub source

  // Basic context
  context: z.string().optional(),
  cause: z.string().optional(),
  resolution: z.string().optional(),

  // Enriched context (from error-enrichment agent)
  triggerScenarios: z.string().optional(),
  commonSituations: z.array(z.string()).optional(),
  exampleFix: z.string().optional(),
  preventionTips: z.array(z.string()).optional(),

  // Defensive strategies (from defense-advisor agent)
  handlingStrategy: z.enum(["retry", "fallback", "crash", "log-continue"]).optional(),
  validationCode: z.string().optional(),
  typeGuard: z.string().optional(),
  tryCatchPattern: z.string().optional(),

  // Article recommendations (from article-recommender agent)
  recommendedArticles: z.array(z.string()).optional(),
  suggestedNewArticles: z.array(SuggestedArticleSchema).optional(),
});

// Alias for backwards compatibility
export type AnalyzedError = z.infer<typeof ExtractedErrorSchema>;

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
