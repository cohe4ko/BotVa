import { describe, it, expect } from 'vitest'
import { matchAgents } from './agent-matcher.js'
import type { AgentProfile } from './agent-catalog.js'

function makeProfile(slug: string, name: string, description: string): AgentProfile {
  return { slug, name, description, emoji: '🤖', prompt: 'test prompt' }
}

const CATALOG: AgentProfile[] = [
  makeProfile('engineering-code-reviewer', 'Code Reviewer', 'Expert code reviewer who provides constructive feedback on correctness and security'),
  makeProfile('engineering-software-architect', 'Software Architect', 'Expert software architect specializing in system design and architectural patterns'),
  makeProfile('engineering-backend-architect', 'Backend Architect', 'Senior backend architect specializing in scalable system design and API development'),
  makeProfile('engineering-frontend-developer', 'Frontend Developer', 'Expert frontend developer specializing in React and modern web technologies'),
  makeProfile('engineering-database-optimizer', 'Database Optimizer', 'Expert database specialist focusing on schema design and query optimization'),
  makeProfile('testing-api-tester', 'API Tester', 'Expert API testing specialist focused on comprehensive API validation'),
  makeProfile('testing-performance-benchmarker', 'Performance Benchmarker', 'Expert performance testing and optimization specialist'),
  makeProfile('design-ui-designer', 'UI Designer', 'Expert UI designer specializing in visual design systems'),
  makeProfile('design-ux-architect', 'UX Architect', 'Technical architecture and UX specialist'),
  makeProfile('marketing-seo-specialist', 'SEO Specialist', 'Expert search engine optimization strategist'),
  makeProfile('product-manager', 'Product Manager', 'Holistic product leader who owns the full product lifecycle'),
  makeProfile('sales-deal-strategist', 'Deal Strategist', 'Senior deal strategist specializing in MEDDPICC qualification'),
  makeProfile('engineering-git-workflow-master', 'Git Workflow Master', 'Expert in Git workflows, branching strategies and version control'),
  makeProfile('engineering-security-engineer', 'Security Engineer', 'Expert application security engineer specializing in threat modeling'),
]

describe('matchAgents', () => {
  it('matches "review code" to code reviewer', () => {
    const result = matchAgents('review my code please', CATALOG)
    expect(result[0].slug).toBe('engineering-code-reviewer')
  })

  it('matches "design UI" to ui designer', () => {
    const result = matchAgents('design a new UI for the dashboard', CATALOG)
    expect(result.some(a => a.slug === 'design-ui-designer')).toBe(true)
  })

  it('matches "database optimization" to db optimizer', () => {
    const result = matchAgents('optimize database queries', CATALOG)
    expect(result.some(a => a.slug === 'engineering-database-optimizer')).toBe(true)
  })

  it('matches "test API" to api tester', () => {
    const result = matchAgents('test the API endpoints', CATALOG)
    expect(result.some(a => a.slug === 'testing-api-tester')).toBe(true)
  })

  it('matches "security vulnerability" to security engineer', () => {
    const result = matchAgents('check for security vulnerabilities', CATALOG)
    expect(result[0].slug).toBe('engineering-security-engineer')
  })

  it('matches "git branch strategy" to git workflow master', () => {
    const result = matchAgents('help with git branch strategy', CATALOG)
    expect(result.some(a => a.slug === 'engineering-git-workflow-master')).toBe(true)
  })

  it('matches "SEO" to seo specialist', () => {
    const result = matchAgents('improve SEO ranking', CATALOG)
    expect(result[0].slug).toBe('marketing-seo-specialist')
  })

  it('returns empty for unrelated task', () => {
    const result = matchAgents('привіт як справи', CATALOG)
    expect(result).toHaveLength(0)
  })

  it('returns empty for empty input', () => {
    expect(matchAgents('', CATALOG)).toHaveLength(0)
    expect(matchAgents('test', [])).toHaveLength(0)
  })

  it('respects limit parameter', () => {
    const result = matchAgents('review code architecture and test performance', CATALOG, 3)
    expect(result.length).toBeLessThanOrEqual(3)
  })

  it('returns multiple matches for broad tasks', () => {
    const result = matchAgents('architect a backend API with database', CATALOG)
    expect(result.length).toBeGreaterThan(1)
    const slugs = result.map(a => a.slug)
    expect(slugs).toContain('engineering-backend-architect')
  })

  it('matches product-related queries', () => {
    const result = matchAgents('create a product roadmap', CATALOG)
    expect(result.some(a => a.slug === 'product-manager')).toBe(true)
  })
})
