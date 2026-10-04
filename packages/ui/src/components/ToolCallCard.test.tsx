/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PrototypeToolCall } from "@valuz/shared";

// MarkdownContent pulls in Streamdown/katex/shiki — heavy and irrelevant here.
// Stub it so we can assert *what* gets handed to the markdown renderer.
vi.mock("./conversation/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => (
    <pre data-testid="markdown-content">{content}</pre>
  ),
}));

import { ToolCallCard } from "./ToolCallCard";

const call = (over: Partial<PrototypeToolCall>): PrototypeToolCall => ({
  id: "t1",
  kind: "fetch",
  title: "tool",
  status: "success",
  ...over,
});

const PLAN = "# UI/UX Redesign — AI 保单管家 V1.1\n\n## Context\n\nCurrent state.";

describe("ToolCallCard — plan tools", () => {
  it("ExitPlanMode renders the plan as markdown, open by default, headline as subtitle", () => {
    render(
      <ToolCallCard
        tc={call({
          title: "ExitPlanMode",
          // The turn builder passes the tool input verbatim: a JSON string.
          input: JSON.stringify({ plan: PLAN }),
          subtitle: JSON.stringify({ plan: PLAN }), // raw JSON the generic path would show
        })}
      />,
    );
    // Plan is handed to the markdown renderer (not dumped as escaped JSON),
    // and it is visible without expanding (open by default).
    expect(screen.getByTestId("markdown-content").textContent).toContain(
      "## Context",
    );
    // The first heading becomes the collapsed-header subtitle, `#` stripped.
    expect(
      screen.getByText("UI/UX Redesign — AI 保单管家 V1.1"),
    ).toBeTruthy();
    // The raw JSON subtitle must NOT leak into the header.
    expect(screen.queryByText(/"plan":/)).toBeNull();
  });

  it("EnterPlanMode gets a friendly subtitle and no markdown body", () => {
    render(<ToolCallCard tc={call({ title: "EnterPlanMode", input: "{}" })} />);
    // zh-CN is the default test locale.
    expect(screen.getByText("进入计划模式")).toBeTruthy();
    expect(screen.queryByTestId("markdown-content")).toBeNull();
  });

  it("a generic tool is unchanged: raw input pre, no markdown, folded by default", () => {
    render(
      <ToolCallCard
        tc={call({ title: "Bash", subtitle: "ls -la", input: "ls -la" })}
      />,
    );
    // Folded: input not shown until expanded, and never as markdown.
    expect(screen.queryByTestId("markdown-content")).toBeNull();
    expect(screen.queryByText("Input")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.queryByTestId("markdown-content")).toBeNull();
  });
});
