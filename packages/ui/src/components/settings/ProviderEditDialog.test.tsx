import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ProviderEditDialog } from "./ProviderEditDialog";

// jsdom shims Radix Dialog needs.
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

const baseProps = {
  open: true,
  onOpenChange: () => {},
  providerId: "prov-1",
  providerName: "yylx relay",
  providerKind: "compatible",
  providerDisplayName: "Custom",
  currentBaseUrl: "https://app.yylx.io", // the stored (old) endpoint
  currentProtocol: "anthropic",
  supportsCustomBaseUrl: true,
  supportsProtocolSelection: true,
  docsUrl: "",
  defaultBaseUrl: "", // compatible channel → the protocol effect no-ops
  onSave: vi.fn().mockResolvedValue(undefined),
  onDiscoverModels: vi.fn().mockResolvedValue({ models: [] }),
  onPing: vi.fn().mockResolvedValue({ ok: ["claude-sonnet-5"], failed: [] }),
};

describe("ProviderEditDialog — a just-typed endpoint survives a parent re-render", () => {
  it("does not reset the endpoint when the parent passes a fresh initialModels array", async () => {
    const user = userEvent.setup();
    // The parent (ModelSection) rebuilds ``initialModels`` as ``models.map(...)``
    // on every render — a brand-new array reference each time.
    const { rerender } = render(
      <ProviderEditDialog {...baseProps} initialModels={["claude-sonnet-5"]} />,
    );

    // Endpoint field starts at the stored value, then the user retypes it.
    const endpoint = screen.getByDisplayValue(
      "https://app.yylx.io",
    ) as HTMLInputElement;
    await user.clear(endpoint);
    await user.type(endpoint, "https://direct.yylx.io");
    expect(endpoint.value).toBe("https://direct.yylx.io");

    // A parent re-render with a NEW initialModels reference — the exact trigger
    // that used to re-run the reset effect and wipe the field back to the stored
    // endpoint (so a ping/save then hit the OLD app.yylx.io and 503'd).
    rerender(
      <ProviderEditDialog {...baseProps} initialModels={["claude-sonnet-5"]} />,
    );

    expect(
      (screen.getByDisplayValue("https://direct.yylx.io") as HTMLInputElement)
        .value,
    ).toBe("https://direct.yylx.io");
    // ...and it must NOT have reverted to the old endpoint.
    expect(screen.queryByDisplayValue("https://app.yylx.io")).toBeNull();
  });
});

describe("ProviderEditDialog — 'test before save' toggle", () => {
  it("unchecked → saves straight through without pinging", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onPing = vi.fn().mockResolvedValue({ ok: [], failed: [] });
    render(
      <ProviderEditDialog
        {...baseProps}
        onSave={onSave}
        onPing={onPing}
        initialModels={["claude-sonnet-5"]}
      />,
    );

    // Default is checked → uncheck it.
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onPing).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("checked (default) + every model fails → aborts the save", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onPing = vi.fn().mockResolvedValue({
      ok: [],
      failed: [{ model: "claude-sonnet-5", reason: "503" }],
    });
    render(
      <ProviderEditDialog
        {...baseProps}
        onSave={onSave}
        onPing={onPing}
        initialModels={["claude-sonnet-5"]}
      />,
    );

    // Leave the checkbox on (default) and save.
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onPing).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
