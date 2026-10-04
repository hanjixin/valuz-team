/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "@valuz/shared/i18n";

import { ExportProjectDialog } from "./ExportProjectDialog";

const { exportProjectMock } = vi.hoisted(() => ({
  exportProjectMock: vi
    .fn()
    .mockResolvedValue({
      blob: new Blob(["x"]),
      filename: "demo.valuzpack",
    }),
}));

vi.mock("@valuz/core", async () => {
  const actual = await vi.importActual<typeof import("@valuz/core")>(
    "@valuz/core",
  );
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      exportProject: exportProjectMock,
    },
  };
});

beforeAll(() => initI18n({ locale: "en-US", fallbackLocale: "en-US" }));

// Anchor.click + createObjectURL must be stubbed (jsdom has no downloads).
const clickSpy = vi.fn();
const revokeSpy = vi.fn();
beforeAll(() => {
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = revokeSpy;
  // Capture anchor clicks without navigating.
  const origCreateElement = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "a") el.click = clickSpy;
    return el;
  }) as typeof document.createElement;
  return () => {
    URL.createObjectURL = origCreate;
  };
});

describe("ExportProjectDialog", () => {
  it("calls exportProject and triggers a download on confirm", async () => {
    render(
      <ExportProjectDialog
        projectId="p1"
        projectName="Demo"
        open
        onOpenChange={() => {}}
      />,
    );
    const btn = await screen.findByRole("button", { name: "Export project" });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(exportProjectMock).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(revokeSpy).toHaveBeenCalledWith("blob:mock");
  });
});
