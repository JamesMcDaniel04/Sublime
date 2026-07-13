type ArtifactTemplate = {
  name: string
  description: string
  departments?: string[]
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

const artifacts: Record<string, string> = {
  sales: `<article><p><strong>Opportunity brief</strong> · Created today</p><h2>Acme Corp — Enterprise Expansion</h2><table><tbody><tr><th>Qualified value</th><td>$84,000 ARR</td></tr><tr><th>Stage</th><td>Discovery</td></tr><tr><th>Owner</th><td>Sarah Chen</td></tr><tr><th>Target close</th><td>September 30</td></tr></tbody></table><h3>Why this is qualified</h3><p>Acme has 420 employees, matches the enterprise ICP, and is replacing a manual approval process used by Finance and Operations. The buyer confirmed budget ownership and a Q3 decision window.</p><h3>Recommended next step</h3><p>Schedule a 45-minute workflow review with the VP of Operations and send the security overview before Friday.</p><blockquote>Salesforce opportunity created · Owner notified in #sales</blockquote></article>`,
  engineering: `<article><p><strong>Engineering brief</strong> · Release 2.14</p><h2>Release readiness summary</h2><p><strong>Verdict:</strong> Ready after one required change</p><h3>Blocker</h3><ul><li><strong>Database migration:</strong> add a rollback for the new workspace index before merge.</li></ul><h3>Checks passed</h3><ul><li>48 automated tests passed</li><li>No public API contract changes detected</li><li>Authentication and permission paths covered</li></ul><h3>What changed</h3><p>Users can now route inbound Slack messages to an agent and preserve thread context across replies.</p><blockquote>Linear ENG-482 updated · Review posted to #eng-reviews</blockquote></article>`,
  marketing: `<article><p><strong>Campaign performance brief</strong> · Week ending July 12</p><h2>Self-Serve Launch</h2><table><tbody><tr><th>New MQLs</th><td>186 <strong>+18%</strong></td></tr><tr><th>MQL → SQL</th><td>31.2% <strong>+4.1 pts</strong></td></tr><tr><th>Pipeline sourced</th><td>$246,000</td></tr></tbody></table><h3>What worked</h3><p>The customer-story email produced the highest conversion rate, while paid social supplied volume but fewer sales-qualified leads.</p><h3>Next-week plan</h3><ol><li>Reuse the customer proof angle in the launch webinar.</li><li>Move 15% of paid-social budget to the email retargeting audience.</li><li>Test a role-specific landing page for Operations leaders.</li></ol></article>`,
  finance: `<article><p><strong>Finance operating brief</strong> · July 12</p><h2>Cash and revenue snapshot</h2><table><tbody><tr><th>Revenue MTD</th><td>$1.24M</td></tr><tr><th>Plan variance</th><td><strong>-4.8%</strong></td></tr><tr><th>Cash balance</th><td>$6.7M</td></tr><tr><th>DSO</th><td>43 days</td></tr></tbody></table><h3>Attention required</h3><p>$192,400 is more than 60 days overdue. Acme Corp and Northstar account for 61% of the balance.</p><h3>Recommended actions</h3><ol><li>Escalate both accounts to their executive owners.</li><li>Confirm the disputed Northstar invoice by Wednesday.</li><li>Keep the current forecast; downside remains within the 5% threshold.</li></ol></article>`,
  csm: `<article><p><strong>Customer health brief</strong> · Acme Corp</p><h2>QBR and renewal readiness</h2><table><tbody><tr><th>ARR</th><td>$180,000</td></tr><tr><th>Renewal</th><td>September 30</td></tr><tr><th>Health score</th><td><strong>72 / 100</strong></td></tr><tr><th>Open escalations</th><td>2</td></tr></tbody></table><h3>Wins</h3><ul><li>Three new teams onboarded this quarter.</li><li>Weekly active usage increased 22%.</li></ul><h3>Risks</h3><p>Two unresolved billing tickets and no confirmed executive sponsor for renewal.</p><h3>Recommended conversation</h3><p>Resolve billing ownership first, then propose the analytics add-on around the customer’s reporting goal.</p></article>`,
}

/** A populated end-product preview, not a description of how the automation runs. */
export function exampleArtifactHtml(template: ArtifactTemplate): string {
  const department = template.departments?.[0]?.toLowerCase() || 'general'
  const body = artifacts[department]
  if (body) return body
  return `<article><p><strong>Completed deliverable</strong> · Today</p><h2>${escapeHtml(template.name)}</h2><h3>Executive summary</h3><p>The requested analysis is complete. The strongest signal is a recurring handoff delay between ownership and follow-through, affecting three active workstreams.</p><h3>Recommended decision</h3><p>Assign one accountable owner, set a 48-hour response target, and review progress in the next operating meeting.</p><h3>Next actions</h3><ol><li>Resolve the two overdue items.</li><li>Confirm owners and dates.</li><li>Share the brief with stakeholders.</li></ol></article>`
}
