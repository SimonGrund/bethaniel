// ── Model Setup — first-run model downloader with hardware-tier gating ──

import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { getSocket } from "../socket";

interface CatalogEntry {
  id: string;
  tier: "medium" | "large";
  name: string;
  description: string;
  fileName: string;
  sizeBytes: number;
  minRamGb: number;
  minRamAppleSiliconGb: number;
  allowed: boolean;
}

interface HardwareInfo {
  totalRamGb: number;
  freeRamGb: number;
  platform: string;
  arch: string;
  appleSilicon: boolean;
  cpuCount: number;
  gpu: { vendor: string; vramGb: number | null };
  allowedTiers: string[];
}

interface InstalledModel {
  id: string;
  tier: string;
  name: string;
  fileName: string;
}

interface DownloadProgress {
  modelId: string;
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
  status?: string;
  error?: string;
}

const BASE = import.meta.env.VITE_API_URL ?? "";

export default function ModelSetup({ onReady }: { onReady: () => void }) {
  const { lang } = useStore();
  const t = useTranslation(lang);

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [installed, setInstalled] = useState<InstalledModel[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch hardware + catalog + installed on mount
  useEffect(() => {
    Promise.all([
      fetch(`${BASE}/api/hardware`).then((r) => r.json()),
      fetch(`${BASE}/api/models/catalog`).then((r) => r.json()),
      fetch(`${BASE}/api/models/installed`).then((r) => r.json()),
    ]).then(([hw, cat, inst]) => {
      setHardware(hw);
      setCatalog(cat.catalog ?? []);
      setInstalled(inst.installed ?? []);
    });
  }, []);

  // Socket.IO download progress
  useEffect(() => {
    const socket = getSocket();
    const handler = (data: DownloadProgress) => {
      setProgress(data);
      if (data.status === "done") {
        setDownloading(null);
        // Refresh installed list
        fetch(`${BASE}/api/models/installed`)
          .then((r) => r.json())
          .then((inst) => setInstalled(inst.installed ?? []));
      } else if (data.status === "error") {
        setDownloading(null);
        setError(data.error ?? "Download failed");
      }
    };
    socket.on("model:download", handler);
    return () => {
      socket.off("model:download", handler);
    };
  }, []);

  // If a model is already installed, allow proceeding
  useEffect(() => {
    if (installed.length > 0) {
      // Don't auto-proceed — let the user choose to continue
    }
  }, [installed]);

  async function startDownload(modelId: string) {
    setError(null);
    setDownloading(modelId);
    setProgress(null);
    try {
      const res = await fetch(`${BASE}/api/models/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Download failed");
        setDownloading(null);
        return;
      }
      if (data.status === "already_installed") {
        setDownloading(null);
        fetch(`${BASE}/api/models/installed`)
          .then((r) => r.json())
          .then((inst) => setInstalled(inst.installed ?? []));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
      setDownloading(null);
    }
  }

  async function deleteModel(fileName: string) {
    await fetch(`${BASE}/api/models/${encodeURIComponent(fileName)}`, {
      method: "DELETE",
    });
    const inst = await fetch(`${BASE}/api/models/installed`).then((r) =>
      r.json(),
    );
    setInstalled(inst.installed ?? []);
  }

  function formatBytes(bytes: number): string {
    const gb = bytes / 1024 ** 3;
    return gb >= 1
      ? `${gb.toFixed(1)} GB`
      : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  }

  const hasInstalledModel = installed.length > 0;

  return (
    <div className="model-setup">
      <div className="model-setup-header">
        <h1>Bethaniel</h1>
        <p className="model-setup-subtitle">{t("subtitle")}</p>
      </div>

      <div className="model-setup-body">
        <h2>{t("model_setup_title")}</h2>
        <p className="model-setup-description">{t("model_setup_desc")}</p>

        {hardware && (
          <div className="hardware-info">
            <span className="hardware-badge">{hardware.totalRamGb} GB RAM</span>
            {hardware.appleSilicon && (
              <span className="hardware-badge hardware-badge-gpu">
                Apple Silicon
              </span>
            )}
            {hardware.gpu.vendor === "nvidia" && hardware.gpu.vramGb && (
              <span className="hardware-badge hardware-badge-gpu">
                NVIDIA {hardware.gpu.vramGb.toFixed(0)} GB VRAM
              </span>
            )}
          </div>
        )}

        <div className="model-cards">
          {catalog.map((entry) => {
            const isInstalled = installed.some((i) => i.id === entry.id);
            const isDownloading = downloading === entry.id;
            const isDisabled = !entry.allowed && !isInstalled;
            const minRam = hardware?.appleSilicon
              ? entry.minRamAppleSiliconGb
              : entry.minRamGb;

            return (
              <div
                key={entry.id}
                className={`model-card ${isDisabled ? "model-card-disabled" : ""} ${isInstalled ? "model-card-installed" : ""}`}
              >
                <div className="model-card-header">
                  <span className="model-tier-badge">{entry.tier}</span>
                  <h3>{entry.name}</h3>
                </div>
                <p className="model-card-desc">{entry.description}</p>
                <div className="model-card-meta">
                  <span>{formatBytes(entry.sizeBytes)}</span>
                  <span>
                    {t("model_requires")} {minRam} GB RAM
                  </span>
                </div>

                {isDownloading && progress && progress.modelId === entry.id ? (
                  <div className="model-download-progress">
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{ width: `${progress.percent}%` }}
                      />
                    </div>
                    <span className="progress-text">
                      {formatBytes(progress.bytesDownloaded)} /{" "}
                      {formatBytes(progress.totalBytes)} ({progress.percent}%)
                    </span>
                  </div>
                ) : isInstalled ? (
                  <div className="model-card-actions">
                    <span className="model-installed-badge">
                      ✓ {t("model_installed")}
                    </span>
                    <button
                      className="btn-link btn-danger"
                      onClick={() => deleteModel(entry.fileName)}
                    >
                      {t("model_delete")}
                    </button>
                  </div>
                ) : (
                  <div className="model-card-actions">
                    <button
                      className="btn-primary"
                      disabled={isDisabled || downloading !== null}
                      onClick={() => startDownload(entry.id)}
                      title={
                        isDisabled
                          ? `${t("model_requires")} ${minRam} GB RAM — ${t("model_your_machine")} ${hardware?.totalRamGb ?? "?"} GB`
                          : undefined
                      }
                    >
                      {isDisabled
                        ? t("model_insufficient_ram")
                        : t("model_download")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {error && <div className="model-error">{error}</div>}

        {hasInstalledModel && (
          <div className="model-setup-continue">
            <button className="btn-primary btn-large" onClick={onReady}>
              {t("model_continue")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
