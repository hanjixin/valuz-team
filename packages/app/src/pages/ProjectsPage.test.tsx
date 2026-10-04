import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "@valuz/shared/i18n";
import { agentsApi, projectsApi } from "@valuz/core";
import { PlatformProvider } from "@valuz/app/platform";
import type { PlatformCapabilities } from "@valuz/core";
import { ProjectsPage } from "./ProjectsPage";

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return {
    ...actual,
    useOutletContext: () => ({
      setRightPanel: vi.fn(),
      setHeader: vi.fn(),
      setHeaderClassName: vi.fn(),
      setHideHeader: vi.fn(),
      setAsideClassName: vi.fn(),
      setMainClassName: vi.fn(),
      setContentInnerClassName: vi.fn(),
    }),
  };
});

const platform: PlatformCapabilities = {
  selectDirectory: vi.fn(),
  copyFiles: vi.fn(),
  deleteFile: vi.fn(),
  revealInFinder: vi.fn(),
  quitApp: vi.fn(),
  openNewWindow: vi.fn(),
  isElectron: false,
  isMac: false,
};

describe("ProjectsPage", () => {
  beforeEach(() => {
    initI18n({ locale: "en-US", fallbackLocale: "en-US" });
    vi.spyOn(projectsApi, "list").mockResolvedValue({ projects: [] });
    vi.spyOn(agentsApi, "listAgents").mockResolvedValue({ agents: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates managed cloud projects without showing or sending a local directory", async () => {
    const create = vi.spyOn(projectsApi, "create").mockResolvedValue({
      id: "p1",
      name: "Cloud",
      kind: "project",
      root_path: null,
      cwd: null,
      icon: null,
      instructions_md: "",
    });

    render(
      <MemoryRouter>
        <PlatformProvider value={platform}>
          <ProjectsPage directoryFieldMode="managed" />
        </PlatformProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("No projects, click create")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(screen.getByText(/managed directory/)).toBeTruthy();
    expect(screen.queryByText("Select directory")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("my-project"), {
      target: { value: "Cloud" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Create" }).at(-1)!);

    await waitFor(() => {
      // Second arg is the execution-target opts — undefined on
      // single-target builds (no targets registered in this test).
      expect(create).toHaveBeenCalledWith({ name: "Cloud" }, undefined);
    });
  });
});
