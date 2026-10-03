import { type ChangeEvent, useEffect, useState } from "react";
import { del, get, post, put } from "../api.ts";
import type { Me } from "../main.tsx";
import { ShareDialog } from "../share.tsx";
import { Btn, Badge, ErrorLine, Field, Page, PermissionBadge, can, timeAgo, useAction, useLoad } from "../ui.tsx";

export function SettingsPage({ me }: { me: Me }) {
  const admin = me.role === "owner" || me.role === "admin";
  const config = useLoad<any>("/v1/storage/config");
  const files = useLoad<{ data: any[] }>("/v1/files");
  const [f, setF] = useState({ driver: "local", endpoint: "", region: "us-east-1", bucket: "", prefix: "", access_key_id: "", secret_access_key: "", force_path_style: false });
  const [saved, setSaved] = useState(false);
  const [sharing, setSharing] = useState<any | null>(null);
  const action = useAction();
  const upload = useAction();

  useEffect(() => {
    if (!config.data) return;
    const known = Object.fromEntries(Object.entries(config.data as Record<string, unknown>).filter(([k, v]) => v !== null && k !== "updated_at"));
    setF((prev) => ({ ...prev, ...known, secret_access_key: "" }));
  }, [config.data]);

  const save = () =>
    action.run(async () => {
      setSaved(false);
      await put(
        "/v1/storage/config",
        f.driver === "local"
          ? { driver: "local" }
          : {
              driver: "s3", endpoint: f.endpoint || null, region: f.region, bucket: f.bucket, prefix: f.prefix, access_key_id: f.access_key_id,
              force_path_style: f.force_path_style, ...(f.secret_access_key ? { secret_access_key: f.secret_access_key } : {}),
            },
      );
      setSaved(true);
      await config.reload();
    });

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void upload.run(async () => {
      // The bytes go straight to storage through the signed link; only metadata passes through the API.
      const created = await post("/v1/files", { name: file.name, content_type: file.type || "application/octet-stream" });
      const res = await fetch(created.upload.url, { method: "PUT", headers: created.upload.headers, body: file });
      if (!res.ok) throw new Error(`上传失败（存储返回 ${res.status}）`);
      await post(`/v1/files/${created.file.id}/complete`);
      await files.reload();
    });
  };
  const download = (file: any) => upload.run(async () => void window.open((await get(`/v1/files/${file.id}/download`)).url, "_blank"));
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <Page title="设置">
      <div className="stack">
        <section className="card stack">
          <h3>云存储</h3>
          <div className="muted small">组织共享文件的存放位置。{admin ? "保存时会实际写入一个探测对象，写不进去就不会保存。" : "只有组织所有者和管理员可以修改。"}</div>
          <Field label="存储方式">
            <select disabled={!admin} value={f.driver} onChange={set("driver")}>
              <option value="local">服务器本地磁盘</option>
              <option value="s3">S3 兼容对象存储（AWS / COS / OSS / MinIO / R2）</option>
            </select>
          </Field>
          {f.driver === "s3" ? (
            <>
              <div className="row">
                <div className="grow"><Field label="Endpoint" hint="AWS 留空；COS / OSS / MinIO 填服务地址"><input disabled={!admin} value={f.endpoint} onChange={set("endpoint")} placeholder="https://cos.ap-shanghai.myqcloud.com" /></Field></div>
                <div style={{ width: 160 }}><Field label="Region"><input disabled={!admin} value={f.region} onChange={set("region")} /></Field></div>
              </div>
              <div className="row">
                <div className="grow"><Field label="Bucket"><input disabled={!admin} value={f.bucket} onChange={set("bucket")} /></Field></div>
                <div className="grow"><Field label="路径前缀（可选）"><input disabled={!admin} value={f.prefix} onChange={set("prefix")} /></Field></div>
              </div>
              <div className="row">
                <div className="grow"><Field label="Access Key ID"><input disabled={!admin} value={f.access_key_id} onChange={set("access_key_id")} autoComplete="off" /></Field></div>
                <div className="grow">
                  <Field label="Secret Access Key" hint={config.data?.driver === "s3" ? "留空则保持不变" : "加密保存，不会再返回"}>
                    <input disabled={!admin} type="password" value={f.secret_access_key} onChange={set("secret_access_key")} autoComplete="off" />
                  </Field>
                </div>
              </div>
              <label className="row small">
                <input style={{ width: "auto" }} disabled={!admin} type="checkbox" checked={f.force_path_style} onChange={(e) => setF({ ...f, force_path_style: e.target.checked })} />
                使用 path-style 地址（MinIO 需要）
              </label>
            </>
          ) : null}
          <ErrorLine>{action.error}</ErrorLine>
          {admin ? (
            <div className="row">
              <Btn className="primary" disabled={action.busy} onClick={() => void save()}>{action.busy ? "正在验证…" : "保存"}</Btn>
              {saved ? <Badge tone="ok">已保存并验证可写</Badge> : null}
            </div>
          ) : null}
        </section>

        <section className="card stack">
          <div className="row">
            <h3 className="grow">共享文件</h3>
            <label>
              <input type="file" hidden onChange={onFile} />
              <span className="badge info" style={{ cursor: "pointer", padding: "5px 12px", fontSize: 13 }}>{upload.busy ? "处理中…" : "上传文件"}</span>
            </label>
          </div>
          <ErrorLine>{upload.error ?? files.error}</ErrorLine>
          {files.data?.data.length === 0 ? <div className="muted small">还没有文件。上传的文件默认只有你能看到，共享后同事才能下载。</div> : null}
          {files.data?.data.map((file) => (
            <div className="item" key={file.id}>
              <div className="grow">
                <span className="title">{file.name}</span>{" "}
                <span className="muted small">{file.size} B · {file.driver === "s3" ? "对象存储" : "服务器磁盘"} · {timeAgo(file.created_at)}</span>
              </div>
              <PermissionBadge value={file.permission} />
              <Btn onClick={() => void download(file)}>下载</Btn>
              {can(file.permission, "admin") ? <Btn onClick={() => setSharing(file)}>共享</Btn> : null}
              {can(file.permission, "admin") ? <Btn className="ghost danger" onClick={() => void upload.run(async () => { await del(`/v1/files/${file.id}`); await files.reload(); })}>删除</Btn> : null}
            </div>
          ))}
        </section>
      </div>
      {sharing ? <ShareDialog base={`/v1/files/${sharing.id}`} kind="file" title={sharing.name} onClose={() => setSharing(null)} /> : null}
    </Page>
  );
}
