import { glob as fg } from "tinyglobby";
import path from "path";
import { readFile, writeFile } from "fs/promises";
import crypto from "crypto";

function fileNameToRoutePath(fileName: string): string {
  let routePath = fileName.replace(/\.(ts)$/, "");
  routePath = routePath.split(path.sep).join("/");
  routePath = routePath.replace(/\[([^\]]+)\]/g, (_, p1: string) => (p1.startsWith("...") ? "*" : `:${p1}`));
  if (routePath === "index") return "/";
  routePath = routePath.replace(/\/index$/, "");
  routePath = "/" + routePath.replace(/\/+/g, "/").replace(/\/$/, "");
  return routePath;
}

type RouteModulePair = { routePath: string; varName: string; entry: string };

const ROUTER_GENERATOR_VERSION = 4;
const PUBLIC_PROTOCOL_ROOTS = ["/v1", "/v1beta"] as const;
const ROUTE_GLOBS = ["src/routes/**/*.ts", "!src/routes/**/handlers.ts"] as const;

export default async function generateRouter(): Promise<void> {
  // Only modules with a default route export belong in the generated router.
  // Handler implementation files are imported by their route index instead.
  let entries: string[] = await fg([...ROUTE_GLOBS]);
  // 排序
  entries = entries.sort((a, b) => a.localeCompare(b));

  const importLines: string[] = [];
  const routeModulePairs: RouteModulePair[] = [];

  entries.forEach((entry: string, i: number) => {
    const varName = `route${i + 1}`;
    let importPath = path.relative("src", entry).replace(/\\/g, "/");
    if (!importPath.startsWith(".")) importPath = "./" + importPath;
    importPath = importPath.replace(/\.ts$/, "");
    importLines.push(`import ${varName} from "${importPath}";`);
    const routeKey = path.relative("src/routes", entry).replace(/\\/g, "/");
    const routePath = fileNameToRoutePath(routeKey);
    routeModulePairs.push({ routePath, varName, entry });
  });
  // Include the generator policy in the hash. Otherwise changing mount rules
  // without adding/removing a route leaves a stale generated router behind.
  const routerData = JSON.stringify({
    version: ROUTER_GENERATOR_VERSION,
    publicProtocolRoots: PUBLIC_PROTOCOL_ROOTS,
    routeGlobs: ROUTE_GLOBS,
    routes: routeModulePairs.map(({ routePath, varName }) => ({ routePath, varName })),
  });
  const hash = crypto.createHash("md5").update(routerData).digest("hex");

  let content = `// @routes-hash ${hash}\nimport { Express } from "express";\n\n`;
  content += `${importLines.join("\n")}\n\n`;
  content += `export default async (app: Express) => {\n`;
  for (const { routePath, varName } of routeModulePairs) {
    // OpenAI/Anthropic and Gemini compatible clients treat /v1 and /v1beta as
    // the server root. 0.2.3 removes the former /api-prefixed compatibility
    // aliases so there is one public address for every protocol family.
    if (PUBLIC_PROTOCOL_ROOTS.some((root) => routePath === root || routePath.startsWith(`${root}/`))) {
      content += `  app.use("${routePath}", ${varName});\n`;
    } else {
      content += `  app.use("/api${routePath}", ${varName});\n`;
    }
  }
  content += `}\n`;

  let needWrite = true;
  try {
    const current = await readFile("src/router.ts", "utf8");
    const match = current.match(/^\/\/\s*@routes-hash\s*([a-z0-9]+)\n/);
    const currentHash = match ? match[1] : null;
    if (currentHash === hash) {
      needWrite = false;
    }
  } catch {
    needWrite = true;
  }
  if (needWrite) await writeFile("src/router.ts", content, "utf8");
}
