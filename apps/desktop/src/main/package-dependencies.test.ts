import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const electronBuilderConfigPath = resolve(
  here,
  "../../build/electron-builder.yml",
);

describe("desktop package dependencies", () => {
  it("excludes only known large renderer packages from app.asar", () => {
    const config = readFileSync(electronBuilderConfigPath, "utf8");

    expect(config).not.toContain('- "!node_modules/**"');
    expect(config).toContain('- "!node_modules/@fontsource/**"');
    expect(config).toContain('- "!node_modules/mermaid/**"');
    expect(config).toContain('- "!node_modules/@mermaid-js/**"');
    expect(config).toContain('- "!node_modules/lucide-react/**"');
    expect(config).toContain('- "!node_modules/date-fns/**"');
    expect(config).toContain('- "!node_modules/date-fns-jalali/**"');
    expect(config).toContain('- "!node_modules/@shikijs/**"');
    expect(config).toContain('- "!node_modules/shiki/**"');
    expect(config).toContain('- "!node_modules/@base-ui/**"');
    expect(config).toContain('- "!node_modules/@reduxjs/**"');
    expect(config).toContain('- "!node_modules/react-dom/**"');
    expect(config).toContain('- "!node_modules/recharts/**"');
    expect(config).toContain('- "!node_modules/xlsx/**"');
    expect(config).toContain('- "!node_modules/codepage/**"');
    expect(config).toContain('- "!node_modules/cytoscape/**"');
    expect(config).toContain('- "!node_modules/cytoscape-fcose/**"');
    expect(config).toContain('- "!node_modules/zod/**"');
    expect(config).toContain('- "!node_modules/@radix-ui/**"');
    expect(config).toContain('- "!node_modules/langium/**"');
    expect(config).toContain('- "!node_modules/katex/**"');
    expect(config).toContain('- "!node_modules/react-router/**"');
    expect(config).toContain('- "!node_modules/@valuz/**"');
    expect(config).toContain('- "!node_modules/@codemirror/**"');
    expect(config).toContain('- "!node_modules/lodash-es/**"');
    expect(config).toContain('- "!node_modules/react-day-picker/**"');
    expect(config).toContain('- "!node_modules/react-hook-form/**"');
    expect(config).toContain('- "!node_modules/@hookform/**"');
    expect(config).toContain('- "!node_modules/dayjs/**"');
    expect(config).toContain('- "!node_modules/chevrotain/**"');
    expect(config).toContain('- "!node_modules/@lezer/**"');
    expect(config).toContain('- "!node_modules/victory-vendor/**"');
    expect(config).toContain('- "!node_modules/@babel/**"');
    expect(config).toContain('- "!node_modules/es-toolkit/**"');
  });
});
