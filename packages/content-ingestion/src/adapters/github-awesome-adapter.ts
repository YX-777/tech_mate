import { Article, FetchOptions, IContentAdapter } from "../types";

/**
 * GitHub Awesome READMEs adapter
 *
 * 拉取几个知名 awesome 仓库的 README，按 `## ` heading 切分，
 * 每个 section 作为一条 Article。
 *
 * 数据源：raw.githubusercontent.com，完全合规、稳定。
 */

interface AwesomeRepo {
  /** GitHub 仓库路径 owner/repo */
  repo: string;
  /** 默认分支 */
  branch: string;
  /** README 文件路径 */
  readmePath: string;
  /** 主题类目 */
  category: string;
  /** 备注 */
  hint: string;
}

const REPOS: AwesomeRepo[] = [
  // —— 前端框架 ——
  { repo: "enaqx/awesome-react", branch: "master", readmePath: "README.md", category: "frontend", hint: "React 生态" },
  { repo: "vuejs/awesome-vue", branch: "master", readmePath: "README.md", category: "frontend", hint: "Vue 生态" },
  { repo: "PatrickJS/awesome-angular", branch: "master", readmePath: "README.md", category: "frontend", hint: "Angular 生态" },
  { repo: "agarrharr/awesome-static-website-services", branch: "master", readmePath: "readme.md", category: "frontend", hint: "静态站点服务" },
  // —— 工程化 / 工具 ——
  { repo: "sorrycc/awesome-javascript", branch: "master", readmePath: "README.md", category: "frontend", hint: "JS 经典" },
  { repo: "dypsilon/frontend-dev-bookmarks", branch: "master", readmePath: "readme.md", category: "frontend", hint: "前端工程师收藏夹" },
  { repo: "sotayamashita/awesome-css", branch: "master", readmePath: "readme.md", category: "frontend", hint: "CSS 资源" },
  { repo: "willianjusten/awesome-svg", branch: "master", readmePath: "README.md", category: "frontend", hint: "SVG 资源" },
  // —— 后端 / 全栈 ——
  { repo: "sindresorhus/awesome-nodejs", branch: "main", readmePath: "readme.md", category: "backend", hint: "Node.js 生态" },
  { repo: "nikitavoloboev/awesome-nodejs", branch: "main", readmePath: "readme.md", category: "backend", hint: "Node.js 备选" },
  { repo: "veggiemonk/awesome-docker", branch: "master", readmePath: "README.md", category: "backend", hint: "Docker 生态" },
  // —— AI / Agent / LLM ——
  { repo: "e2b-dev/awesome-ai-agents", branch: "main", readmePath: "README.md", category: "ai", hint: "AI Agents" },
  { repo: "Hannibal046/Awesome-LLM", branch: "main", readmePath: "README.md", category: "ai", hint: "LLM 资源" },
  { repo: "EthicalML/awesome-production-machine-learning", branch: "master", readmePath: "README.md", category: "ai", hint: "生产 ML" },
  { repo: "kyrolabs/awesome-langchain", branch: "main", readmePath: "README.md", category: "ai", hint: "LangChain 生态" },
  { repo: "kasperjunge/awesome-rag", branch: "main", readmePath: "README.md", category: "ai", hint: "RAG 资源" },
  { repo: "f/awesome-chatgpt-prompts", branch: "main", readmePath: "README.md", category: "ai", hint: "Prompt 工程" },
  // —— TypeScript & 工程化 ——
  { repo: "dzharii/awesome-typescript", branch: "main", readmePath: "README.md", category: "frontend", hint: "TS 资源" },
  { repo: "jaredpalmer/awesome-react-typescript", branch: "main", readmePath: "README.md", category: "frontend", hint: "React+TS" },
  // —— Round-2 补量（更多主题）——
  { repo: "ramnes/awesome-mongodb", branch: "master", readmePath: "README.md", category: "backend", hint: "MongoDB 资源" },
  { repo: "agarrharr/awesome-cli-apps", branch: "master", readmePath: "readme.md", category: "backend", hint: "CLI 工具" },
  { repo: "iAJTin/awesome-clean-code", branch: "main", readmePath: "README.md", category: "general", hint: "整洁代码" },
  { repo: "sotayamashita/awesome-package-manager", branch: "master", readmePath: "readme.md", category: "frontend", hint: "包管理器" },
  { repo: "phuocng/css-layout", branch: "master", readmePath: "README.md", category: "frontend", hint: "CSS 布局技巧" },
  { repo: "Awesome-Microservices/awesome-microservices", branch: "master", readmePath: "readme.md", category: "backend", hint: "微服务" },
  { repo: "chentsulin/awesome-graphql", branch: "master", readmePath: "README.md", category: "backend", hint: "GraphQL 生态" },
  { repo: "ramitsurana/awesome-kubernetes", branch: "master", readmePath: "README.md", category: "backend", hint: "K8s 资源" },
  { repo: "guardrail-ml/awesome-llm-security", branch: "main", readmePath: "README.md", category: "ai", hint: "LLM 安全" },
  { repo: "tensorchord/Awesome-LLMOps", branch: "main", readmePath: "README.md", category: "ai", hint: "LLMOps" },
  { repo: "tensorflow/tensor2tensor", branch: "master", readmePath: "README.md", category: "ai", hint: "Tensor2Tensor 文档" },
  { repo: "awesome-foss/awesome-sysadmin", branch: "master", readmePath: "README.md", category: "backend", hint: "运维工具" },
];

async function fetchText(url: string, timeoutMs = 20000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "TechMate-Ingestion/1.0" },
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 按 `## ` 切分 markdown，每个 section 作为一篇
 * 跳过过短的 section
 */
function splitByH2(md: string): Array<{ title: string; body: string }> {
  // 用 `\n## ` 切，第一段是 H1 前的导言，可保留作为 intro
  const parts = md.split(/\n##\s+/);
  if (parts.length < 2) return [];
  const head = parts[0];
  const sections: Array<{ title: string; body: string }> = [];

  // 头部如果包含 H1，可以单独作为 intro 部分
  const introMatch = head.match(/^#\s+(.+)$/m);
  if (introMatch && head.length > 500) {
    sections.push({ title: introMatch[1].trim() + " · 导言", body: head });
  }

  for (let i = 1; i < parts.length; i++) {
    const piece = parts[i];
    const firstLine = piece.split("\n")[0].trim();
    const body = "## " + piece;
    if (body.length < 500) continue;
    sections.push({ title: firstLine.replace(/[#`*]/g, "").trim(), body });
  }
  return sections;
}

export class GithubAwesomeAdapter implements IContentAdapter {
  readonly source = "github-awesome";

  async fetch(options: FetchOptions = {}): Promise<Article[]> {
    const limit = options.limit ?? 80;
    const verbose = options.verbose;
    const articles: Article[] = [];

    for (const repo of REPOS) {
      if (articles.length >= limit) break;
      // jsdelivr CDN 比 raw.githubusercontent.com 在国内稳定得多
      const url = `https://cdn.jsdelivr.net/gh/${repo.repo}@${repo.branch}/${repo.readmePath}`;
      const md = await fetchText(url);
      if (!md) {
        if (verbose) console.log(`[awesome] ${repo.repo} fetch failed, skip`);
        continue;
      }
      const sections = splitByH2(md);
      if (verbose) console.log(`[awesome] ${repo.repo} → ${sections.length} sections`);

      for (const sec of sections) {
        if (articles.length >= limit) break;
        articles.push({
          title: `${repo.hint} · ${sec.title}`,
          content: sec.body,
          source: this.source,
          sourceUrl: `https://github.com/${repo.repo}`,
          category: repo.category,
          author: repo.repo,
          tags: ["awesome", repo.category],
        });
      }
    }

    return articles;
  }
}
