export const TEMPLATE_OUTPUT_STANDARD = `
Output quality standard:
- Produce a decision-ready artifact, not a terse status update or skeletal brief. Include enough context and substance that the user should not need to ask you to expand it.
- Stay focused and skimmable: lead with the outcome, then include the material evidence, analysis, risks or gaps, and concrete next actions with owners and dates when supported.
- Use descriptive section headings, short paragraphs, tables or bullets where they improve comprehension, and specific values or examples from connected sources. Clearly mark unknowns instead of inventing them.
- When the destination supports HTML, create polished semantic HTML with strong visual hierarchy, tasteful emoji section markers, status callouts, metric cards or tables, and a professional finish. For Slack, use readable mrkdwn and restrained emoji. For plain text, use structured Markdown.
- If a node requires a strict JSON schema, honor that schema exactly and populate its fields with sufficient detail for downstream nodes; do not wrap JSON in HTML or Markdown.
- Do not pad the response or repeat the same point. Completeness matters more than raw length.`.trim()

export function withTemplateOutputStandard(instructions: string): string {
  if (instructions.includes('Output quality standard:')) return instructions
  return `${instructions.trim()}\n\n${TEMPLATE_OUTPUT_STANDARD}`
}
