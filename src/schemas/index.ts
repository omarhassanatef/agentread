import { z } from "zod";
import type { Limits } from "../config/env.js";

/**
 * Versioned, shared schemas. The HTTP API and MCP tools validate input with the same
 * shapes and return the same result objects. Bump SCHEMA_VERSION on breaking changes.
 */
export const SCHEMA_VERSION = "1.0";

const urlField = (limits: Limits) =>
  z
    .string({ required_error: "url is required", invalid_type_error: "url must be a string" })
    .min(1, "url is required")
    .max(limits.maxUrlLength, `url must be at most ${limits.maxUrlLength} characters`)
    .describe("Absolute public http:// or https:// URL. Default ports only; no credentials; no IP literals.");

export function inspectInputShape(limits: Limits) {
  return { url: urlField(limits) };
}

export function extractInputShape(limits: Limits) {
  return {
    url: urlField(limits),
    maxCharacters: z
      .number({ invalid_type_error: "maxCharacters must be a number" })
      .int("maxCharacters must be an integer")
      .min(100, "maxCharacters must be at least 100")
      .max(limits.maxCharactersLimit, `maxCharacters must be at most ${limits.maxCharactersLimit}`)
      .optional()
      .describe(`Maximum Markdown characters to return (default ${limits.defaultMaxCharacters}, max ${limits.maxCharactersLimit}).`),
    includeLinks: z
      .boolean({ invalid_type_error: "includeLinks must be a boolean" })
      .optional()
      .describe("Keep hyperlinks and images in the Markdown (default true). When false, link text is kept as plain text."),
  };
}

export const inspectInputSchema = (limits: Limits) => z.object(inspectInputShape(limits)).strict();
export const extractInputSchema = (limits: Limits) => z.object(extractInputShape(limits)).strict();

export type InspectInput = z.infer<ReturnType<typeof inspectInputSchema>>;
export type ExtractInput = z.infer<ReturnType<typeof extractInputSchema>>;

export const headingSchema = z.object({ level: z.number().int().min(1).max(6), text: z.string() });
export const linkSchema = z.object({ text: z.string(), url: z.string() });

export const extractionMethodSchema = z.enum(["readability", "main-content-fallback", "body-fallback", "plain-text", "lite"]);

export const extractionInfoSchema = z.object({
  method: extractionMethodSchema,
  statusCode: z.number().int(),
  contentType: z.string().nullable(),
  charset: z.string(),
  redirects: z.number().int(),
  bytesFetched: z.number().int(),
  characters: z.number().int().describe("Length of the returned Markdown."),
  totalCharacters: z.number().int().describe("Length of the Markdown before truncation."),
  words: z.number().int(),
  warnings: z.array(z.string()),
  durationMs: z.number(),
});

export const extractResultSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  operation: z.literal("extract_url"),
  requestedUrl: z.string(),
  finalUrl: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  markdown: z.string(),
  headings: z.array(headingSchema),
  truncated: z.boolean(),
  extraction: extractionInfoSchema,
});

export const pageMetadataSchema = z.object({
  title: z.string().nullable(),
  description: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  language: z.string().nullable(),
  siteName: z.string().nullable(),
  byline: z.string().nullable(),
  publishedTime: z.string().nullable(),
});

export const structuredResultSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  operation: z.literal("extract_url_structured"),
  requestedUrl: z.string(),
  finalUrl: z.string(),
  metadata: pageMetadataSchema,
  markdown: z.string(),
  headings: z.array(headingSchema),
  headingsTruncated: z.boolean(),
  links: z.array(linkSchema),
  linksTruncated: z.boolean(),
  truncated: z.boolean(),
  extraction: extractionInfoSchema,
});

export const inspectResultSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  operation: z.literal("inspect_url"),
  requestedUrl: z.string(),
  normalizedUrl: z.string(),
  hostname: z.string(),
  reachable: z.boolean(),
  statusCode: z.number().int().nullable(),
  finalUrl: z.string().nullable(),
  redirects: z.number().int(),
  contentType: z.string().nullable(),
  contentLength: z.number().int().nullable(),
  isHtml: z.boolean(),
  title: z.string().nullable(),
  mayRequireJavaScript: z.boolean(),
  extractionSupported: z.boolean(),
  limitation: z.string().nullable(),
});

export type Heading = z.infer<typeof headingSchema>;
export type Link = z.infer<typeof linkSchema>;
export type ExtractionMethod = z.infer<typeof extractionMethodSchema>;
export type ExtractionInfo = z.infer<typeof extractionInfoSchema>;
export type ExtractResult = z.infer<typeof extractResultSchema>;
export type StructuredResult = z.infer<typeof structuredResultSchema>;
export type PageMetadata = z.infer<typeof pageMetadataSchema>;
export type InspectResult = z.infer<typeof inspectResultSchema>;
