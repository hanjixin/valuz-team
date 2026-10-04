import { render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsApi, tasksApi } from "@valuz/core";
import { routes } from "./router";

vi.mock("@valuz/app/lib/onboarding", () => ({
  isOnboarded: () => true,
}));

describe("webui routes", () => {
  beforeEach(() => {
    // ChatPage's session picker calls sessionsApi.list() on mount.
    // Stub it so the test environment doesn't try to hit the backend
    // and so we can assert on the empty-state UI deterministically.
    vi.spyOn(sessionsApi, "list").mockResolvedValue({ sessions: [] });
    vi.spyOn(tasksApi, "listAllTasks").mockResolvedValue({ tasks: [] });
  });

  it("should render the app shell when navigating to a conversation route", async () => {
    const router = createMemoryRouter(routes, {
      initialEntries: ["/conversation/new"],
    });

    render(<RouterProvider router={router} />);

    expect(await screen.findByLabelText("Valuz Agent menu")).toBeTruthy();
  });
});
