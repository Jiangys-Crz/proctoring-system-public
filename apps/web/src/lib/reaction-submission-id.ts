/** Preserve NovaJudge UUIDs, local Hydro sub_UUIDs, native Hydro ObjectIds and legacy CUIDs. */
export function isReactionSubmissionId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:(?:sub_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24}|c[a-z0-9]{24})$/i.test(value);
}
