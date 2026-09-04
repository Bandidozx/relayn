/**
 * Code samples for the Integrations and Documentation pages.
 *
 * These are generated from the live base URL and the caller's own key so that anything
 * copied out of the UI runs unmodified against this deployment. `PLACEHOLDER_KEY` is used
 * whenever no key is selected — the snippet stays copy-pasteable but obviously incomplete.
 */
export const PLACEHOLDER_KEY = "rly_live_YOUR_API_KEY";

export interface SnippetContext {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Snippet {
  id: string;
  label: string;
  language: string;
  filename: string;
  code: string;
}

const q = (value: string) => JSON.stringify(value);

export function curlSnippet({ baseUrl, apiKey, model }: SnippetContext): string {
  return `curl ${baseUrl}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "model": "${model}",
    "messages": [
      { "role": "user", "content": "Explain rate limiting in one sentence." }
    ]
  }'`;
}

export function curlStreamSnippet({ baseUrl, apiKey, model }: SnippetContext): string {
  return `curl -N ${baseUrl}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "model": "${model}",
    "stream": true,
    "messages": [{ "role": "user", "content": "Count to five." }]
  }'`;
}

export function pythonOpenAiSnippet({ baseUrl, apiKey, model }: SnippetContext): string {
  return `# pip install openai
from openai import OpenAI

client = OpenAI(
    api_key=${q(apiKey)},
    base_url=${q(`${baseUrl}/v1`)},
)

response = client.chat.completions.create(
    model=${q(model)},
    messages=[{"role": "user", "content": "Explain rate limiting in one sentence."}],
)

print(response.choices[0].message.content)
print(response.usage.total_tokens, "tokens billed")`;
}

export function pythonStreamSnippet({ baseUrl, apiKey, model }: SnippetContext): string {
  return `from openai import OpenAI

client = OpenAI(api_key=${q(apiKey)}, base_url=${q(`${baseUrl}/v1`)})

stream = client.chat.completions.create(
    model=${q(model)},
    messages=[{"role": "user", "content": "Count to five."}],
    stream=True,
)

for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)`;
}

export function nodeOpenAiSnippet({ baseUrl, apiKey, model }: SnippetContext): string {
  return `// npm install openai
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: ${q(apiKey)},
  baseURL: ${q(`${baseUrl}/v1`)},
});

const response = await client.chat.completions.create({
  model: ${q(model)},
  messages: [{ role: "user", content: "Explain rate limiting in one sentence." }],
});

console.log(response.choices[0].message.content);`;
}

export function nodeStreamSnippet({ baseUrl, apiKey, model }: SnippetContext): string {
  return `import OpenAI from "openai";

const client = new OpenAI({ apiKey: ${q(apiKey)}, baseURL: ${q(`${baseUrl}/v1`)} });

const stream = await client.chat.completions.create({
  model: ${q(model)},
  messages: [{ role: "user", content: "Count to five." }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`;
}

export function fetchSnippet({ baseUrl, apiKey, model }: SnippetContext): string {
  return `const response = await fetch(${q(`${baseUrl}/v1/chat/completions`)}, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: \`Bearer \${${q(apiKey)}}\`,
  },
  body: JSON.stringify({
    model: ${q(model)},
    messages: [{ role: "user", content: "Explain rate limiting in one sentence." }],
  }),
});

if (!response.ok) {
  const { error } = await response.json();
  throw new Error(\`\${error.code}: \${error.message}\`);
}

const data = await response.json();
console.log(data.choices[0].message.content);`;
}

export function anthropicSnippet({ baseUrl, apiKey, model }: SnippetContext): string {
  return `# The Anthropic-dialect endpoint accepts x-api-key or Authorization: Bearer.
# pip install anthropic
from anthropic import Anthropic

client = Anthropic(api_key=${q(apiKey)}, base_url=${q(baseUrl)})

message = client.messages.create(
    model=${q(model)},
    max_tokens=512,
    messages=[{"role": "user", "content": "Explain rate limiting in one sentence."}],
)

print(message.content[0].text)`;
}

export function langchainSnippet({ baseUrl, apiKey, model }: SnippetContext): string {
  return `# pip install langchain-openai
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model=${q(model)},
    api_key=${q(apiKey)},
    base_url=${q(`${baseUrl}/v1`)},
)

print(llm.invoke("Explain rate limiting in one sentence.").content)`;
}

export function listModelsSnippet({ baseUrl, apiKey }: SnippetContext): string {
  return `curl ${baseUrl}/v1/models \\
  -H "Authorization: Bearer ${apiKey}"`;
}

export function envSnippet({ baseUrl, apiKey }: SnippetContext): string {
  return `OPENAI_API_KEY=${apiKey}
OPENAI_BASE_URL=${baseUrl}/v1`;
}

/** Tabs shared by the Integrations page and the docs quickstart. */
export function quickstartSnippets(context: SnippetContext): Snippet[] {
  return [
    { id: "curl", label: "cURL", language: "bash", filename: "request.sh", code: curlSnippet(context) },
    {
      id: "python",
      label: "Python",
      language: "python",
      filename: "relayn_example.py",
      code: pythonOpenAiSnippet(context),
    },
    {
      id: "node",
      label: "Node.js",
      language: "typescript",
      filename: "relayn-example.ts",
      code: nodeOpenAiSnippet(context),
    },
    {
      id: "fetch",
      label: "REST / fetch",
      language: "typescript",
      filename: "rest.ts",
      code: fetchSnippet(context),
    },
  ];
}

export function streamingSnippets(context: SnippetContext): Snippet[] {
  return [
    {
      id: "curl-stream",
      label: "cURL",
      language: "bash",
      filename: "stream.sh",
      code: curlStreamSnippet(context),
    },
    {
      id: "python-stream",
      label: "Python",
      language: "python",
      filename: "stream.py",
      code: pythonStreamSnippet(context),
    },
    {
      id: "node-stream",
      label: "Node.js",
      language: "typescript",
      filename: "stream.ts",
      code: nodeStreamSnippet(context),
    },
  ];
}
