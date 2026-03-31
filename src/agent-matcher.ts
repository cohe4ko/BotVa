import type { AgentProfile } from './agent-catalog.js'

// --- Keyword map: token → agent slugs (or category prefixes) ---

const KEYWORD_MAP: Record<string, string[]> = {
  // Engineering
  'code': ['engineering-code-reviewer', 'engineering-senior-developer'],
  'review': ['engineering-code-reviewer'],
  'pr': ['engineering-code-reviewer', 'engineering-git-workflow-master'],
  'refactor': ['engineering-code-reviewer', 'engineering-senior-developer'],
  'architect': ['engineering-software-architect', 'engineering-backend-architect'],
  'backend': ['engineering-backend-architect'],
  'frontend': ['engineering-frontend-developer'],
  'api': ['engineering-backend-architect', 'testing-api-tester'],
  'database': ['engineering-database-optimizer'],
  'db': ['engineering-database-optimizer'],
  'sql': ['engineering-database-optimizer'],
  'devops': ['engineering-devops-automator'],
  'deploy': ['engineering-devops-automator'],
  'ci': ['engineering-devops-automator'],
  'docker': ['engineering-devops-automator'],
  'security': ['engineering-security-engineer'],
  'vulnerability': ['engineering-security-engineer'],
  'mobile': ['engineering-mobile-app-builder'],
  'ios': ['engineering-mobile-app-builder'],
  'android': ['engineering-mobile-app-builder'],
  'git': ['engineering-git-workflow-master'],
  'branch': ['engineering-git-workflow-master'],
  'merge': ['engineering-git-workflow-master'],
  'ai': ['engineering-ai-engineer'],
  'ml': ['engineering-ai-engineer'],
  'model': ['engineering-ai-engineer'],
  'firmware': ['engineering-embedded-firmware-engineer'],
  'embedded': ['engineering-embedded-firmware-engineer'],
  'prototype': ['engineering-rapid-prototyper'],
  'mvp': ['engineering-rapid-prototyper'],
  'solidity': ['engineering-solidity-smart-contract-engineer'],
  'smart contract': ['engineering-solidity-smart-contract-engineer'],
  'blockchain': ['engineering-solidity-smart-contract-engineer'],
  'incident': ['engineering-incident-response-commander'],
  'sre': ['engineering-sre'],
  'reliability': ['engineering-sre'],

  // Testing & QA
  'test': ['testing-api-tester', 'testing-performance-benchmarker'],
  'qa': ['testing-evidence-collector', 'testing-test-results-analyzer'],
  'performance': ['testing-performance-benchmarker'],
  'benchmark': ['testing-performance-benchmarker'],
  'accessibility': ['testing-accessibility-auditor'],
  'a11y': ['testing-accessibility-auditor'],

  // Design & UX
  'design': ['design-ui-designer', 'design-ux-architect'],
  'ui': ['design-ui-designer'],
  'ux': ['design-ux-architect', 'design-ux-researcher'],
  'brand': ['design-brand-guardian'],
  'visual': ['design-visual-storyteller'],

  // Product & PM
  'product': ['product-manager'],
  'prd': ['product-manager'],
  'roadmap': ['product-manager'],
  'sprint': ['product-sprint-prioritizer'],
  'prioritize': ['product-sprint-prioritizer'],
  'feedback': ['product-feedback-synthesizer'],
  'trend': ['product-trend-researcher'],
  'project': ['project-management-project-shepherd'],

  // Marketing
  'seo': ['marketing-seo-specialist', 'marketing-baidu-seo-specialist'],
  'content': ['marketing-content-creator'],
  'social media': ['marketing-social-media-strategist'],
  'tiktok': ['marketing-tiktok-strategist'],
  'instagram': ['marketing-instagram-curator'],
  'linkedin': ['marketing-linkedin-content-creator'],
  'twitter': ['marketing-twitter-engager'],
  'youtube': ['marketing-content-creator'],
  'growth': ['marketing-growth-hacker'],
  'ecommerce': ['marketing-cross-border-ecommerce'],

  // Sales
  'sales': ['sales-coach', 'sales-deal-strategist'],
  'deal': ['sales-deal-strategist'],
  'pipeline': ['sales-pipeline-analyst'],
  'proposal': ['sales-proposal-strategist'],
  'outbound': ['sales-outbound-strategist'],

  // Writing & Docs
  'document': ['specialized-document-generator', 'engineering-technical-writer'],
  'docs': ['engineering-technical-writer'],
  'write': ['marketing-content-creator', 'engineering-technical-writer'],
  'article': ['marketing-content-creator'],
  'book': ['marketing-book-co-author'],

  // Compliance & Legal
  'compliance': ['compliance-auditor', 'support-legal-compliance-checker'],
  'legal': ['support-legal-compliance-checker'],
  'audit': ['compliance-auditor'],

  // Data
  'data': ['engineering-data-engineer', 'support-analytics-reporter'],
  'analytics': ['support-analytics-reporter'],
  'dashboard': ['support-analytics-reporter'],

  // MCP
  'mcp': ['specialized-mcp-builder'],

  // Workflow
  'workflow': ['specialized-workflow-architect', 'testing-workflow-optimizer'],
  'automate': ['testing-workflow-optimizer'],
  'automation': ['testing-workflow-optimizer'],
}

// --- Tokenizer ---

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s\u0400-\u04FF]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
}

// --- Scoring ---

function scoreAgent(profile: AgentProfile, taskTokens: string[], taskLower: string): number {
  let score = 0

  // 1. Keyword map hits (strongest signal)
  for (const token of taskTokens) {
    const mapped = KEYWORD_MAP[token]
    if (mapped?.includes(profile.slug)) {
      score += 10
    }
  }

  // Also check 2-word phrases
  for (const phrase of Object.keys(KEYWORD_MAP)) {
    if (phrase.includes(' ') && taskLower.includes(phrase)) {
      if (KEYWORD_MAP[phrase].includes(profile.slug)) {
        score += 12
      }
    }
  }

  // 2. Token overlap with name + description (weaker signal)
  const profileTokens = tokenize(`${profile.name} ${profile.description}`)
  for (const token of taskTokens) {
    if (profileTokens.includes(token)) {
      score += 2
    }
  }

  // 3. Substring match in description
  for (const token of taskTokens) {
    if (token.length > 3 && profile.description.toLowerCase().includes(token)) {
      score += 1
    }
  }

  return score
}

// --- Public API ---

export function matchAgents(
  task: string,
  catalog: AgentProfile[],
  limit = 5
): AgentProfile[] {
  if (!task || catalog.length === 0) return []

  const taskLower = task.toLowerCase()
  const taskTokens = tokenize(task)

  const scored = catalog
    .map(profile => ({ profile, score: scoreAgent(profile, taskTokens, taskLower) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limit, 8))

  return scored.map(({ profile }) => profile)
}
