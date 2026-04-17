/**
 * ShogAgent Web Extension for pi-coding-agent
 *
 * Converted from web-tools.ts customTools format to pi extension format.
 * Provides web_search (DuckDuckGo) and web_fetch capabilities.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true as const };
}

// --- Schemas ---

const WebSearchParams = Type.Object({
  query: Type.String({ description: "The search query" }),
  max_results: Type.Optional(
    Type.Number({ description: "Maximum number of results to return (default: 5)" }),
  ),
});

const WebFetchParams = Type.Object({
  url: Type.String({ description: "The URL to fetch" }),
  max_length: Type.Optional(
    Type.Number({ description: "Maximum response length in characters (default: 20000)" }),
  ),
});

// --- Helpers ---

/** Strip HTML tags and decode common entities, collapse whitespace */
function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Search using DuckDuckGo HTML (no API key needed) */
async function duckDuckGoSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ShogAgent/1.0; +https://github.com/shog-lab/shog-agent)",
    },
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo search failed: ${res.status}`);
  }

  const html = await res.text();
  const results: SearchResult[] = [];

  // Parse DuckDuckGo HTML results (class attr may have multiple values)
  const resultBlocks = html.split(/result__body"/);
  for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
    const block = resultBlocks[i];

    // Extract title and URL
    const titleMatch = block.match(
      /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/,
    );
    // Extract snippet
    const snippetMatch = block.match(
      /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/,
    );

    if (titleMatch) {
      let href = titleMatch[1];
      // DuckDuckGo wraps URLs in a redirect, extract the actual URL
      const uddgMatch = href.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        href = decodeURIComponent(uddgMatch[1]);
      }

      results.push({
        title: htmlToText(titleMatch[2]),
        url: href,
        snippet: snippetMatch ? htmlToText(snippetMatch[1]) : "",
      });
    }
  }

  return results;
}

// --- Extension ---

export default function webExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using DuckDuckGo. Returns titles, URLs, and snippets.",
    parameters: WebSearchParams,
    async execute(_toolCallId: string, params: Static<typeof WebSearchParams>) {
      try {
        const maxResults = params.max_results ?? 5;
        const results = await duckDuckGoSearch(params.query, maxResults);

        if (results.length === 0) {
          return ok(`No results found for: ${params.query}`);
        }

        const formatted = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");

        return ok(formatted);
      } catch (e) {
        return err(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a URL and return its text content. HTML is converted to plain text.",
    parameters: WebFetchParams,
    async execute(_toolCallId: string, params: Static<typeof WebFetchParams>) {
      try {
        const maxLength = params.max_length ?? 20000;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const res = await fetch(params.url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; ShogAgent/1.0; +https://github.com/shog-lab/shog-agent)",
          },
        });
        clearTimeout(timeout);

        if (!res.ok) {
          return err(`Fetch failed: HTTP ${res.status} ${res.statusText}`);
        }

        const contentType = res.headers.get("content-type") || "";
        const raw = await res.text();

        let text: string;
        if (contentType.includes("text/html")) {
          text = htmlToText(raw);
        } else {
          text = raw;
        }

        if (text.length > maxLength) {
          text = text.slice(0, maxLength) + `\n\n... (truncated, ${raw.length} total chars)`;
        }

        return ok(text);
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          return err("Fetch timed out after 15 seconds");
        }
        return err(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });
}
