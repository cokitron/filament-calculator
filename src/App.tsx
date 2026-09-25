import { useState, useEffect, useCallback } from "react";
import Calculator from "./components/Calculator";
import Queue from "./components/Queue";
import History from "./components/History";
import Filaments from "./components/Filaments";
import ShopSettings from "./components/ShopSettings";
import Login from "./components/Login";
import { PrintJob, Filament, Printer, PrinterStatus } from "./types";
import { computeCosts, formatMXN } from "./pricing";
import * as db from "./db/client";
import type { JobHistoryEntry } from "./db/client";
import type { Settings } from "./db/repository";

type Tab = "calculator" | "queue" | "history" | "filaments" | "settings";

/** Placeholder shown only until the first refresh() resolves; never rendered
 * for real since dbState gates the UI to 'ready' before Calculator/ShopSettings mount. */
const emptySettings: Settings = {
  businessName: null,
  rfc: null,
  currency: "MXN",
  electricityRate: 2.8,
  defaultMarkupPercent: 30,
  defaultIvaEnabled: false,
  ivaRate: 0.16,
  failureRatePercent: 8,
  quoteValidityDays: 15,
  minimumOrder: 0,
};

type DbState =
  | { phase: "opening" }
  | { phase: "locked" }
  | { phase: "ready" }
  | { phase: "failed"; message: string };

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("calculator");
  const [dbState, setDbState] = useState<DbState>({ phase: "opening" });
  const [filaments, setFilaments] = useState<Filament[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [queue, setQueue] = useState<PrintJob[]>([]);
  const [history, setHistory] = useState<JobHistoryEntry[]>([]);

  const refresh = useCallback(async () => {
    // The queue holds work in progress; finished jobs move to the history log
    // and are read separately, with the totals frozen at completion.
    const [active, past, fils, prns, sett] = await Promise.all([
      db.listActiveJobs(),
      db.listJobHistory(),
      db.listFilaments(),
      db.listPrinters(),
      db.getSettings(),
    ]);
    setQueue(active);
    setHistory(past);
    setFilaments(fils);
    setPrinters(prns);
    setSettings(sett);
  }, []);

  /** Open storage and load everything. Assumes any required session exists. */
  const start = useCallback(async () => {
    await db.openDatabase();
    // Lift anything the old localStorage version saved. Runs at most once; the
    // database records that it happened. No-op in remote mode.
    await db.importLegacyIfNeeded();
    await refresh();
    setDbState({ phase: "ready" });
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // In remote mode the password gate comes before any data call, so an
        // unauthenticated visitor never sees an empty app that silently fails.
        const session = await db.getSession();
        if (cancelled) return;
        if (!session.authenticated) {
          setDbState({ phase: "locked" });
          return;
        }
        await start();
      } catch (err) {
        if (cancelled) return;
        if (db.isUnauthorized(err)) setDbState({ phase: "locked" });
        else
          setDbState({
            phase: "failed",
            message: err instanceof Error ? err.message : String(err),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [start]);

  const handleLogin = async (password: string) => {
    await db.login(password);
    setDbState({ phase: "opening" });
    await start();
  };

  const handleLogout = async () => {
    await db.logout();
    setQueue([]);
    setHistory([]);
    setFilaments([]);
    setPrinters([]);
    setSettings(emptySettings);
    setDbState({ phase: "locked" });
  };

  /**
   * Run a data mutation, sending the user back to the login screen if the
   * session has expired rather than surfacing a confusing storage error.
   */
  const guard = useCallback(async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (err) {
      if (db.isUnauthorized(err)) {
        setDbState({ phase: "locked" });
        return;
      }
      throw err;
    }
  }, []);

  const addToQueue = async (job: PrintJob) => {
    await guard(async () => {
      await db.saveJob(job);
      await refresh();
      setActiveTab("queue");
    });
  };

  const updateJobStatus = async (id: string, status: PrintJob["status"]) => {
    await guard(async () => {
      await db.updateJobStatus(id, status);
      await refresh();
    });
  };

  const removeJob = async (id: string) => {
    await guard(async () => {
      await db.deleteJob(id);
      await refresh();
    });
  };

  /** Re-quote a finished job by copying it back into the queue. */
  const repeatJob = async (id: string) => {
    await guard(async () => {
      await db.duplicateJob(id);
      await refresh();
      setActiveTab("queue");
    });
  };

  /**
   * Erase a finished job from the work log. Confirmed explicitly because it
   * destroys the only record of that job, and the repository refuses to do it
   * without the force flag for exactly that reason.
   */
  const removeHistoryJob = async (id: string) => {
    const entry = history.find((e) => e.job.id === id);
    const label = entry
      ? `#${String(entry.folio).padStart(4, "0")} ${entry.job.name}`
      : id;
    const ok = window.confirm(
      `Borrar ${label} del historial?\n\n` +
        "Se pierde el registro de ese trabajo: lo que cobraste, el material y la mano de obra. " +
        "No se puede deshacer.",
    );
    if (!ok) return;
    await guard(async () => {
      await db.deleteJob(id, true);
      await refresh();
    });
  };

  const addFilament = async (f: Omit<Filament, "id">) => {
    await guard(async () => {
      await db.createFilament(f);
      await refresh();
    });
  };

  const removeFilament = async (id: string) => {
    await guard(async () => {
      await db.deactivateFilament(id);
      await refresh();
    });
  };

  const addPrinter = async (p: Omit<Printer, "id" | "status">) => {
    await guard(async () => {
      await db.createPrinter(p);
      await refresh();
    });
  };

  const updatePrinterHandler = async (
    id: string,
    patch: Partial<Omit<Printer, "id" | "status">>,
  ) => {
    await guard(async () => {
      await db.updatePrinter(id, patch);
      await refresh();
    });
  };

  const setPrinterStatusHandler = async (id: string, status: PrinterStatus) => {
    await guard(async () => {
      await db.setPrinterStatus(id, status);
      await refresh();
    });
  };

  const updateSettingsHandler = async (patch: Partial<Settings>) => {
    await guard(async () => {
      await db.updateSettings(patch);
      await refresh();
    });
  };

  // Only work still in progress. Finished jobs are revenue already earned, not
  // pipeline, and counting them here made the figure grow forever.
  const totalRevenue = queue.reduce(
    (sum, j) => sum + computeCosts(j, settings).total,
    0,
  );

  if (dbState.phase === "locked") {
    return <Login onSubmit={handleLogin} />;
  }

  if (dbState.phase === "opening") {
    return (
      <div
        className="flex justify-center items-center min-h-screen"
        style={{ background: "var(--color-background)" }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--color-text-muted)",
            letterSpacing: "0.15em",
          }}
        >
          ABRIENDO BASE DE DATOS...
        </div>
      </div>
    );
  }

  if (dbState.phase === "failed") {
    return (
      <div
        className="flex justify-center items-center p-8 min-h-screen"
        style={{ background: "var(--color-background)" }}
      >
        <div
          style={{
            maxWidth: 560,
            border: "1px solid var(--color-red)",
            background: "var(--color-surface)",
            padding: 24,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              fontWeight: 700,
              color: "var(--color-red)",
              letterSpacing: "0.1em",
              marginBottom: 12,
            }}
          >
            NO SE PUDO ABRIR LA BASE DE DATOS
          </div>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--color-text-muted)",
              lineHeight: 1.6,
              marginBottom: 16,
            }}
          >
            {dbState.message}
          </p>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--color-text-dim)",
              lineHeight: 1.6,
            }}
          >
            La causa más común es tener la app abierta en otra pestaña. SQLite
            permite una sola conexión a la vez. Cierra las demás pestañas y
            recarga.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen"
      style={{
        background: "var(--color-background)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Header */}
      <header
        className="app-header"
        style={{
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface)",
        }}
      >
        <div className="flex md:flex-row flex-col md:justify-between md:items-center gap-4 mx-auto px-4 md:px-6 py-4 md:py-6 max-w-7xl">
          <div className="flex items-center gap-3 md:gap-4">
            <div
              className="w-10 md:w-12 h-10 md:h-12"
              style={{
                flexShrink: 0,
                background: "var(--color-orange)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#000"
                strokeWidth="3"
                strokeLinecap="square"
                strokeLinejoin="miter"
              >
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontWeight: 800,
                  fontSize: "clamp(19px, 5.5vw, 24px)",
                  color: "var(--color-text)",
                  letterSpacing: "-0.05em",
                  lineHeight: 1,
                }}
              >
                PRINTDESK
              </div>
              <div
                className="brand-sub"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "var(--color-text-muted)",
                  letterSpacing: "0.15em",
                  marginTop: 4,
                  fontWeight: 700,
                }}
              >
                PRICING // QUEUE // OPS
              </div>
            </div>
          </div>

          <div className="header-metrics">
            <div className="text-right">
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "var(--color-text-muted)",
                  letterSpacing: "0.1em",
                  marginBottom: 4,
                  fontWeight: 700,
                }}
              >
                PIPELINE VALUE
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontWeight: 700,
                  fontSize: "clamp(16px, 4.5vw, 24px)",
                  color: "var(--color-orange)",
                }}
              >
                {formatMXN(totalRevenue)}
              </div>
            </div>
            <div
              className="hidden md:block"
              style={{
                width: 1,
                height: 40,
                background: "var(--color-border)",
              }}
            />
            <div className="text-right">
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "var(--color-text-muted)",
                  letterSpacing: "0.1em",
                  marginBottom: 4,
                  fontWeight: 700,
                }}
              >
                ACTIVE RUNS
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontWeight: 700,
                  fontSize: "clamp(16px, 4.5vw, 24px)",
                  color: "var(--color-text)",
                }}
              >
                {queue.length}
              </div>
            </div>
            <div
              className="hidden md:block"
              style={{
                width: 1,
                height: 40,
                background: "var(--color-border)",
              }}
            />
            <BackupControls onRestored={refresh} onLogout={handleLogout} />
          </div>
        </div>

        {/* Tabs */}
        <div
          className="mx-auto px-4 md:px-6 max-w-7xl tab-bar"
          style={{ borderTop: "1px solid var(--color-border)" }}
        >
          {(
            ["calculator", "queue", "history", "filaments", "settings"] as Tab[]
          ).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className="tab-btn"
              data-active={activeTab === tab}
              style={{
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                cursor: "pointer",
                textTransform: "uppercase",
              }}
            >
              {tab === "calculator"
                ? "NEW JOB ESTIMATE"
                : tab === "queue"
                  ? `QUEUE [${queue.length}]`
                  : tab === "history"
                    ? `WORK HISTORY [${history.length}]`
                    : tab === "filaments"
                      ? "FILAMENT INVENTORY"
                      : "SHOP SETTINGS"}
            </button>
          ))}
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto px-4 md:px-6 py-6 md:py-8 max-w-7xl">
        {activeTab === "calculator" && (
          <Calculator
            onAddToQueue={addToQueue}
            filaments={filaments}
            printers={printers}
            settings={settings}
          />
        )}
        {activeTab === "queue" && (
          <Queue
            jobs={queue}
            onUpdateStatus={updateJobStatus}
            onRemove={removeJob}
          />
        )}
        {activeTab === "history" && (
          <History
            entries={history}
            onDuplicate={repeatJob}
            onDelete={removeHistoryJob}
          />
        )}
        {activeTab === "filaments" && (
          <Filaments
            filaments={filaments}
            onAdd={addFilament}
            onRemove={removeFilament}
          />
        )}
        {activeTab === "settings" && (
          <ShopSettings
            printers={printers}
            settings={settings}
            onAddPrinter={addPrinter}
            onUpdatePrinter={updatePrinterHandler}
            onSetPrinterStatus={setPrinterStatusHandler}
            onUpdateSettings={updateSettingsHandler}
          />
        )}
      </main>
    </div>
  );
}

/**
 * Export and restore the database file, and show where that database lives.
 *
 * Prominent by design. In local mode the database sits in the browser's private
 * filesystem, which "clear site data" destroys without warning, so this file is
 * the only backup that exists. In remote mode the volume holds the data, but
 * this is still the only copy that is off that volume.
 *
 * The storage label is not decoration: knowing whether you are looking at shared
 * data or this device's own copy changes what the numbers mean.
 */
function BackupControls({
  onRestored,
  onLogout,
}: {
  onRestored: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const remote = db.STORAGE_MODE === "remote";

  const handleExport = async () => {
    setBusy(true);
    try {
      const filename = await db.downloadBackup();
      setNote(`Guardado: ${filename}`);
    } catch (err) {
      setNote(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file later
    if (!file) return;

    // Restoring replaces everything and cannot be undone, so it is confirmed
    // explicitly rather than happening on file selection alone.
    const ok = window.confirm(
      `Reemplazar TODA la base de datos con "${file.name}"?\n\n` +
        (remote
          ? "Esto borra los datos del servidor para todos los dispositivos. "
          : "Esto borra los trabajos, clientes y filamentos actuales. ") +
        "No se puede deshacer.",
    );
    if (!ok) return;

    setBusy(true);
    try {
      await db.restoreBackup(file);
      await onRestored();
      setNote("Base de datos restaurada");
    } catch (err) {
      setNote(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="text-right">
      <div
        title={
          remote
            ? "Los datos viven en el servidor y se comparten entre dispositivos."
            : "Los datos viven solo en este navegador. Otro dispositivo no los ve."
        }
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: remote ? "var(--color-green)" : "var(--color-text-muted)",
          letterSpacing: "0.1em",
          marginBottom: 6,
          fontWeight: 700,
        }}
      >
        {remote ? "SERVIDOR" : "ESTE EQUIPO"}
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={handleExport}
          disabled={busy}
          title="Descargar la base de datos como archivo .sqlite3"
          style={backupButtonStyle}
        >
          EXPORTAR
        </button>
        <label
          style={{ ...backupButtonStyle, display: "inline-block" }}
          title="Restaurar desde un archivo .sqlite3"
        >
          IMPORTAR
          <input
            type="file"
            accept=".sqlite3,.sqlite,.db"
            onChange={handleRestore}
            disabled={busy}
            style={{ display: "none" }}
          />
        </label>
        {remote && (
          <button
            onClick={onLogout}
            disabled={busy}
            title="Cerrar sesión"
            style={backupButtonStyle}
          >
            SALIR
          </button>
        )}
      </div>
      {note && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            color: "var(--color-text-dim)",
            marginTop: 4,
            maxWidth: 200,
          }}
        >
          {note}
        </div>
      )}
    </div>
  );
}

const backupButtonStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.05em",
  color: "var(--color-text)",
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-border)",
  padding: "6px 10px",
  cursor: "pointer",
};
