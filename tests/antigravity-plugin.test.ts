import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { createJeanCiMcpHandler, type JeanCiMcpDependencies } from '../lib/mcp/server.ts';
import { InMemoryMcpTaskStore, McpTaskAbortRegistry } from '../lib/mcp/tasks.ts';
import { InMemoryMcpEventsStore } from '../lib/mcp/events.ts';

const REPO_ROOT = process.cwd();

const ALLOWED_PLUGIN_MANIFEST_KEYS = new Set([
  '$schema',
  'name',
  'displayName',
  'description',
  'version',
  'disabled',
  'logo',
  'suggestedPrompts',
  'skills',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);

function parseMarkdownFrontmatter(filePath: string): { frontmatter: Record<string, unknown>; body: string } {
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.ok(!raw.startsWith('\uFEFF'), `${filePath} must not start with a UTF-8 BOM`);
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  assert.ok(match, `${filePath} must contain YAML frontmatter delimited by ---`);
  const parsed = yaml.parse(match[1]);
  assert.equal(typeof parsed, 'object', `${filePath} frontmatter must parse as an object`);
  assert.ok(parsed && !Array.isArray(parsed), `${filePath} frontmatter must be a YAML mapping`);
  return { frontmatter: parsed as Record<string, unknown>, body: match[2] };
}

test('Antigravity plugin manifest (.antigravity-plugin/plugin.json) conforms strictly to v1 schema', () => {
  const manifestPath = path.join(REPO_ROOT, '.antigravity-plugin', 'plugin.json');
  assert.ok(fs.existsSync(manifestPath), '.antigravity-plugin/plugin.json must exist');

  const raw = fs.readFileSync(manifestPath, 'utf8');
  assert.ok(!raw.startsWith('\uFEFF'), 'plugin.json must not start with a UTF-8 BOM');
  const manifest = JSON.parse(raw) as Record<string, unknown>;

  for (const key of Object.keys(manifest)) {
    assert.ok(ALLOWED_PLUGIN_MANIFEST_KEYS.has(key), `unexpected property in plugin.json: ${key}`);
  }

  assert.equal(manifest.$schema, 'https://antigravity.google/schemas/v1/plugin.json');
  assert.equal(typeof manifest.name, 'string');
  assert.match(manifest.name as string, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.doesNotMatch(manifest.name as string, /^(antigravity|gemini|claude|cursor)/i);

  assert.equal(typeof manifest.displayName, 'string');
  assert.ok((manifest.displayName as string).trim().length > 0);
  assert.doesNotMatch(manifest.displayName as string, /\b(plugin|mcp)\b/i);
  assert.doesNotMatch(manifest.displayName as string, /^(antigravity|gemini|claude|cursor)\b/i);

  assert.equal(typeof manifest.version, 'string');
  assert.match(manifest.version as string, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);

  assert.equal(typeof manifest.description, 'string');
  assert.ok((manifest.description as string).length >= 20 && (manifest.description as string).length <= 240);

  // Logo must exist inside plugin root and be a 1:1 SVG
  assert.equal(typeof manifest.logo, 'string');
  const logoPath = path.join(REPO_ROOT, manifest.logo as string);
  assert.ok(fs.existsSync(logoPath), `logo file must exist at ${manifest.logo}`);
  const svgContent = fs.readFileSync(logoPath, 'utf8');
  assert.match(svgContent, /viewBox="0 0 128 128"/);

  // Suggested prompts (1..3 non-empty strings)
  assert.ok(Array.isArray(manifest.suggestedPrompts));
  const prompts = manifest.suggestedPrompts as unknown[];
  assert.ok(prompts.length >= 1 && prompts.length <= 3);
  for (const prompt of prompts) {
    assert.equal(typeof prompt, 'string');
    assert.match(prompt as string, /\S/);
  }

  // Author, homepage, repository URLs must use https://
  assert.ok(manifest.author && typeof manifest.author === 'object' && !Array.isArray(manifest.author));
  const author = manifest.author as Record<string, unknown>;
  assert.equal(typeof author.name, 'string');
  assert.match(author.url as string, /^https:\/\//);
  assert.match(manifest.homepage as string, /^https:\/\//);
  assert.match(manifest.repository as string, /^https:\/\//);

  // Pre-install README exists
  const pluginReadmePath = path.join(REPO_ROOT, '.antigravity-plugin', 'README.md');
  assert.ok(fs.existsSync(pluginReadmePath), '.antigravity-plugin/README.md must exist');
  assert.ok(fs.readFileSync(pluginReadmePath, 'utf8').trim().length > 100);
});

test('mcp_config.json wraps ${JEAN_CI_URL}/mcp with valid variables and registered eager tools', async () => {
  const mcpConfigPath = path.join(REPO_ROOT, 'mcp_config.json');
  assert.ok(fs.existsSync(mcpConfigPath), 'mcp_config.json must exist at plugin root');

  const raw = fs.readFileSync(mcpConfigPath, 'utf8');
  assert.ok(!raw.startsWith('\uFEFF'), 'mcp_config.json must not start with a UTF-8 BOM');
  const config = JSON.parse(raw) as Record<string, unknown>;

  assert.equal('variables' in config, false, 'variables must be declared inside mcpServers.<server>, not at root');
  assert.ok(config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers));

  const servers = config.mcpServers as Record<string, Record<string, unknown>>;
  const jeanCi = servers['jean-ci'];
  assert.ok(jeanCi, 'mcpServers.jean-ci must be defined');
  assert.equal(jeanCi.serverUrl, '${JEAN_CI_URL}/mcp');
  assert.equal(typeof jeanCi.timeoutSeconds, 'number');
  assert.ok((jeanCi.timeoutSeconds as number) >= 300);

  // Verify variable declarations cover all ${...} placeholders in serverUrl/headers
  assert.ok(Array.isArray(jeanCi.variables));
  const variables = jeanCi.variables as Array<Record<string, unknown>>;
  const declaredVarNames = new Set(variables.map((v) => v.name));
  assert.ok(declaredVarNames.has('JEAN_CI_URL'));
  const urlVar = variables.find((v) => v.name === 'JEAN_CI_URL')!;
  assert.equal(typeof urlVar.title, 'string');
  assert.equal(typeof urlVar.description, 'string');
  assert.match(urlVar.link as string, /^https:\/\//);

  // Verify every eager tool listed in mcp_config.json actually exists on the Jean CI MCP server
  const mockDeps: Partial<JeanCiMcpDependencies> = {
    getStats: async () => ({}),
    getOpenPRs: async () => [],
    getAllRepos: async () => [],
    getRepo: async () => null,
    getAllCheckRunsPaginated: async () => ({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
    getCheckRun: async () => null,
    getCheckRunsForPR: async () => [],
    getPRReviewState: async () => null,
    getPipelinesPaginated: async () => ({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
    getDeploymentsPaginated: async () => ({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
    getRecentEventsPaginated: async () => ({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
    getScheduledTasksSummary: async () => [],
    getScheduledTaskEvents: async () => [],
    getFeatureSessionsForRepo: async () => [],
  };

  const handler = createJeanCiMcpHandler({
    baseUrl: 'https://jean-ci.example.com',
    deps: mockDeps as JeanCiMcpDependencies,
    taskStore: new InMemoryMcpTaskStore(),
    taskAbortRegistry: new McpTaskAbortRegistry(),
    eventsStore: new InMemoryMcpEventsStore(),
  });

  const listRes = await handler.fetch(
    new Request('https://jean-ci.example.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'plugin-test', version: '1.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    {
      authInfo: {
        token: 'redacted',
        clientId: 'oauth:1:plugin-test',
        scopes: ['mcp:read', 'mcp:write'],
        extra: { actor: 'github:test', source: 'oauth' },
      },
    },
  );
  assert.equal(listRes.status, 200);
  const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
  const registeredTools = new Set(listJson.result.tools.map((t) => t.name));

  const configuredTools = (jeanCi.tools ?? {}) as Record<string, { eager?: boolean }>;
  assert.ok(Object.keys(configuredTools).length > 0);
  for (const [toolName, toolCfg] of Object.entries(configuredTools)) {
    assert.ok(registeredTools.has(toolName), `mcp_config.json references unknown MCP tool: ${toolName}`);
    assert.equal(typeof toolCfg.eager, 'boolean');
  }
});

test('bundled skills, subagents, and rules conform to Antigravity plugin authoring requirements', () => {
  // 1) Skills
  const skillsRoot = path.join(REPO_ROOT, 'skills');
  assert.ok(fs.existsSync(skillsRoot), 'skills/ directory must exist');
  const skillDirs = fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  assert.deepEqual(skillDirs, ['author-pr-check', 'local-pr-review', 'triage-pr-review']);

  for (const dirName of skillDirs) {
    const skillDir = path.join(skillsRoot, dirName);
    const skillFile = path.join(skillDir, 'SKILL.md');
    assert.ok(fs.existsSync(skillFile), `skills/${dirName}/SKILL.md must exist`);
    const { frontmatter, body } = parseMarkdownFrontmatter(skillFile);
    assert.equal(frontmatter.name, dirName, `SKILL.md name must match directory name (${dirName})`);
    assert.match(frontmatter.name as string, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.equal(typeof frontmatter.description, 'string');
    const desc = (frontmatter.description as string).trim();
    assert.ok(desc.length >= 10 && desc.length <= 1024);

    // Every referenced relative references/*.md file must exist
    for (const refMatch of body.matchAll(/references\/[A-Za-z0-9_.-]+\.md/g)) {
      const refPath = path.join(skillDir, refMatch[0]);
      assert.ok(fs.existsSync(refPath), `referenced file ${refMatch[0]} missing in skills/${dirName}`);
    }
  }

  // 2) Subagents
  const agentsRoot = path.join(REPO_ROOT, 'agents');
  assert.ok(fs.existsSync(agentsRoot), 'agents/ directory must exist');
  const agentFiles = fs.readdirSync(agentsRoot).filter((f) => f.endsWith('.md'));
  assert.ok(agentFiles.includes('jean-ci-reviewer.md'));

  for (const fileName of agentFiles) {
    const { frontmatter } = parseMarkdownFrontmatter(path.join(agentsRoot, fileName));
    assert.equal(typeof frontmatter.name, 'string');
    assert.match(frontmatter.name as string, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.equal(typeof frontmatter.description, 'string');
    assert.equal(frontmatter.inheritMcp, true);
    if (Array.isArray(frontmatter.skills)) {
      for (const skillPath of frontmatter.skills as string[]) {
        assert.ok(
          fs.existsSync(path.join(REPO_ROOT, skillPath, 'SKILL.md')),
          `agent ${fileName} references missing skill path: ${skillPath}`,
        );
      }
    }
    if (Array.isArray(frontmatter.tools)) {
      assert.ok(
        !(frontmatter.tools as string[]).includes('run_command'),
        'read-only reviewer subagent should not allow run_command',
      );
    }
  }

  // 3) Rules
  const rulesRoot = path.join(REPO_ROOT, 'rules');
  assert.ok(fs.existsSync(rulesRoot), 'rules/ directory must exist');
  const ruleFiles = fs.readdirSync(rulesRoot).filter((f) => f.endsWith('.md'));
  assert.ok(ruleFiles.includes('jean-ci-pr-checks.md'));

  for (const fileName of ruleFiles) {
    const { frontmatter } = parseMarkdownFrontmatter(path.join(rulesRoot, fileName));
    assert.ok(
      ['always_on', 'model_decision', 'glob', 'manual'].includes(frontmatter.trigger as string),
      `invalid rule trigger in ${fileName}`,
    );
    if (frontmatter.trigger === 'glob') {
      assert.equal(
        typeof frontmatter.globs,
        'string',
        `globs in rules/${fileName} must be a comma-separated string (not a YAML array)`,
      );
      assert.ok((frontmatter.globs as string).trim().length > 0);
    }
  }
});
