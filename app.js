// ==============================
// Supabase config
// ==============================
const SUPABASE_URL = "https://bduuymwmpjxnkhunreyl.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkdXV5bXdtcGp4bmtodW5yZXlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzMDEzNTMsImV4cCI6MjA4NTg3NzM1M30.jD64IVrN3e9Qjb9Xq1PzMQxplhLmM5FCOtV31gfE8Sc"; // <-- zet hier jouw werkende anon key

// Storage
const STORAGE_BUCKET = "recipe_docs";
const SIGNED_URL_TTL_SECONDS = 60;

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ==============================
// DOM helpers (fail fast)
// ==============================
function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element ontbreekt: #${id}`);
  return el;
}

function setStatus(msg, kind = "") {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "status " + (kind || "muted");
}

function setAuthInfo(msg) {
  const el = document.getElementById("authInfo");
  if (el) el.textContent = msg;
}

// Globale error opvang
window.addEventListener("error", (e) => {
  setStatus("JS fout: " + (e?.message || e), "err");
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = e?.reason?.message || String(e?.reason || e);
  setStatus("Async fout: " + msg, "err");
});

// ==============================
// State
// ==============================
let currentUser = null;
let currentRecipeId = null;
let currentRecipe = null;
let cacheRecipes = [];

// ==============================
// Utils
// ==============================
function normalizeTagsInput(str) {
  return (str || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function tagsToText(tagsArr) {
  return (tagsArr || []).join(", ");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeUuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function inferContentType(file) {
  return file?.type || "application/octet-stream";
}

function buildStoragePath({ userId, recipeId, fileName }) {
  const cleanName = String(fileName || "document").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${userId}/${recipeId}/${safeUuid()}_${cleanName}`;
}

// Drive URL normalisatie (knop moet op alle recepten werken)
function toDriveOpenUrl(url) {
  const s = String(url || "").trim();
  if (!s) return "";

  // /file/d/<id>/view
  const m1 = s.match(/\/d\/([^/]+)/);
  if (m1 && m1[1]) return `https://drive.google.com/open?id=${m1[1]}`;

  // ?id=<id>
  const m2 = s.match(/[?&]id=([^&]+)/);
  if (m2 && m2[1]) return `https://drive.google.com/open?id=${m2[1]}`;

  return s;
}

// ==============================
// Auth
// ==============================
async function refreshAuth() {
  const { data } = await sb.auth.getSession();
  currentUser = data?.session?.user || null;

  if (currentUser) {
    setAuthInfo(`Ingelogd als ${currentUser.email}`);
    document.getElementById("btnLogout").style.display = "";
  } else {
    setAuthInfo("Niet ingelogd");
    document.getElementById("btnLogout").style.display = "none";
  }

  renderFavs();
  updateEditorDocControls();
}

async function loginWithMagicLink() {
  const email = document.getElementById("email").value.trim();
  if (!email) return setStatus("Vul je e-mailadres in.", "err");

  const btn = document.getElementById("btnLogin");
  btn.disabled = true;

  try {
    setStatus("Login link wordt verstuurd…", "muted");
    const redirectTo = window.location.origin + window.location.pathname;

    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo }
    });

    if (error) throw error;
    setStatus("Mail verstuurd. Open de link in je mail om in te loggen.", "ok");
  } catch (e) {
    setStatus("Login fout: " + (e?.message || e), "err");
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  try {
    await sb.auth.signOut();
    currentUser = null;
    cacheRecipes = [];
    clearEditor();
    renderDocs();
    renderFavs();
    setStatus("Uitgelogd.", "muted");
  } catch (e) {
    setStatus("Logout fout: " + (e?.message || e), "err");
  }
}

// ==============================
// Favorites (localStorage) (tags search)
// ==============================
function favKey() {
  return `recepten_favs_${currentUser?.id || "anon"}`;
}

function loadFavs() {
  try { return JSON.parse(localStorage.getItem(favKey()) || "[]"); }
  catch { return []; }
}

function saveFavs(favs) {
  localStorage.setItem(favKey(), JSON.stringify(favs || []));
}

function renderFavs() {
  const list = document.getElementById("favList");
  if (!list) return;

  if (!currentUser) {
    list.innerHTML = `<li class="muted">Login om favorieten te zien.</li>`;
    return;
  }

  const favs = loadFavs();
  if (!favs.length) {
    list.innerHTML = `<li class="muted">Nog geen favorieten.</li>`;
    return;
  }

  list.innerHTML = favs.map((f, idx) => `
    <li class="item">
      <div class="itemTop">
        <div>
          <strong>${escapeHtml(f.name)}</strong>
          <div class="muted">Zoekterm (tags): ${escapeHtml(f.q)}</div>
        </div>
        <div class="actions">
          <button class="btn small secondary" data-fav-run="${idx}">Run</button>
          <button class="btn small danger" data-fav-del="${idx}">X</button>
        </div>
      </div>
    </li>
  `).join("");
}

function wireFavoritesDelegation() {
  document.getElementById("favList").addEventListener("click", (e) => {
    const runBtn = e.target.closest("button[data-fav-run]");
    const delBtn = e.target.closest("button[data-fav-del]");
    if (!runBtn && !delBtn) return;

    if (runBtn) {
      const i = Number(runBtn.getAttribute("data-fav-run"));
      const f = loadFavs()[i];
      document.getElementById("searchInput").value = f?.q || "";
      runTagSearch();
      return;
    }
    if (delBtn) {
      const i = Number(delBtn.getAttribute("data-fav-del"));
      const favs = loadFavs();
      favs.splice(i, 1);
      saveFavs(favs);
      renderFavs();
    }
  });
}

// ==============================
// Data access
// ==============================
async function fetchRecipes() {
  if (!currentUser) {
    cacheRecipes = [];
    return [];
  }

  const { data, error } = await sb
    .from("recipes")
    .select("id,title,tags,file_path,file_name,mime_type,drive_url,updated_at")
    .order("updated_at", { ascending: false });

  if (error) throw error;
  cacheRecipes = data || [];
  return cacheRecipes;
}

async function loadRecipe(id) {
  if (!currentUser) return null;

  const { data, error } = await sb
    .from("recipes")
    .select("id,title,tags,file_path,file_name,mime_type,drive_url,updated_at")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function upsertRecipe(payload) {
  if (!currentUser) throw new Error("Niet ingelogd.");

  const nowIso = new Date().toISOString();

  if (currentRecipeId) {
    const { error } = await sb
      .from("recipes")
      .update({
        title: payload.title,
        tags: payload.tags,
        drive_url: payload.drive_url ?? null,
        updated_at: nowIso
      })
      .eq("id", currentRecipeId);

    if (error) throw error;
    return currentRecipeId;
  } else {
    const { data, error } = await sb
      .from("recipes")
      .insert({
        user_id: currentUser.id,
        title: payload.title,
        tags: payload.tags,
        drive_url: payload.drive_url ?? null,
        updated_at: nowIso
      })
      .select("id")
      .single();

    if (error) throw error;
    return data.id;
  }
}

async function deleteRecipe() {
  if (!currentUser) throw new Error("Niet ingelogd.");
  if (!currentRecipeId) return;

  // document verwijderen (indien aanwezig)
  try {
    const r = currentRecipe || (await loadRecipe(currentRecipeId));
    if (r?.file_path) {
      const { error: delErr } = await sb.storage.from(STORAGE_BUCKET).remove([r.file_path]);
      if (delErr) throw delErr;
    }
  } catch {
    // niet blocken
  }

  const { error } = await sb.from("recipes").delete().eq("id", currentRecipeId);
  if (error) throw error;
}

// ==============================
// Storage
// ==============================
async function openRecipeDocument(recipe) {
  const filePath = recipe?.file_path;
  if (!filePath) throw new Error("Geen document gekoppeld aan dit recept.");

  const { data, error } = await sb.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(filePath, SIGNED_URL_TTL_SECONDS);

  if (error) throw error;
  if (!data?.signedUrl) throw new Error("Kon geen open-link maken.");

  window.open(data.signedUrl, "_blank", "noopener");
}

async function removeRecipeDocument(recipe) {
  if (!recipe?.file_path) return;

  const { error: delErr } = await sb.storage
    .from(STORAGE_BUCKET)
    .remove([recipe.file_path]);

  if (delErr) throw delErr;

  const { error: updErr } = await sb
    .from("recipes")
    .update({ file_path: null, file_name: null, mime_type: null, updated_at: new Date().toISOString() })
    .eq("id", recipe.id);

  if (updErr) throw updErr;
}

async function uploadAndAttachDocument({ recipeId, file }) {
  if (!currentUser) throw new Error("Niet ingelogd.");
  if (!recipeId) throw new Error("Geen recept-ID.");
  if (!file) throw new Error("Geen bestand gekozen.");

  // Oude file verwijderen
  const existing = currentRecipe || (await loadRecipe(recipeId));
  if (existing?.file_path) {
    try { await sb.storage.from(STORAGE_BUCKET).remove([existing.file_path]); } catch {}
  }

  let path = buildStoragePath({ userId: currentUser.id, recipeId, fileName: file.name });
  const contentType = inferContentType(file);

  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await sb.storage
      .from(STORAGE_BUCKET)
      .upload(path, file, { contentType, upsert: false });

    if (!error) break;

    if (String(error.message || "").toLowerCase().includes("already exists")) {
      path = buildStoragePath({ userId: currentUser.id, recipeId, fileName: file.name });
      continue;
    }
    throw error;
  }

  const { error: updErr } = await sb
    .from("recipes")
    .update({
      file_path: path,
      file_name: file.name || null,
      mime_type: contentType || null,
      updated_at: new Date().toISOString()
    })
    .eq("id", recipeId);

  if (updErr) throw updErr;

  return { file_path: path, file_name: file.name || null, mime_type: contentType || null };
}

// ==============================
// UI rendering
// ==============================
function updateEditorDocControls() {
  const openBtn = document.getElementById("btnOpenDoc");
  const rmBtn = document.getElementById("btnRemoveDoc");
  const driveBtn = document.getElementById("btnOpenDrive");
  const hint = document.getElementById("docHint");

  const hasFile = !!(currentRecipe?.file_path && String(currentRecipe.file_path).trim());
  const hasDrive = !!(currentRecipe?.drive_url && String(currentRecipe.drive_url).trim());

  if (openBtn) openBtn.style.display = hasFile ? "" : "none";
  if (rmBtn) rmBtn.style.display = hasFile ? "" : "none";
  if (driveBtn) driveBtn.style.display = hasDrive ? "" : "none";

  if (!hint) return;

  if (!currentUser) {
    hint.textContent = "Login om documenten te uploaden naar cloud storage.";
    return;
  }
  if (!currentRecipeId) {
    hint.textContent = "Kies een bestand. Bij Opslaan wordt eerst het recept aangemaakt en daarna het document geüpload.";
    return;
  }
  if (hasFile) {
    const name = currentRecipe.file_name || "(document)";
    hint.textContent = `Gekoppeld document: ${name}. Je kan het openen of vervangen door een nieuw bestand te kiezen en op Opslaan te klikken.`;
  } else {
    hint.textContent = "Nog geen document gekoppeld. Kies een bestand en klik Opslaan.";
  }
}

function clearEditor() {
  currentRecipeId = null;
  currentRecipe = null;
  document.getElementById("editorTitle").textContent = "Editor";
  document.getElementById("title").value = "";
  document.getElementById("tags").value = "";
  document.getElementById("driveUrl").value = "";
  document.getElementById("docFile").value = "";
  updateEditorDocControls();
}

async function renderDocs() {
  const meta = document.getElementById("docsMeta");
  const list = document.getElementById("docsList");

  if (!currentUser) {
    meta.textContent = "Login om je recepten te zien.";
    list.innerHTML = "";
    return;
  }

  try {
    const docs = await fetchRecipes();
    meta.textContent = `${docs.length} recept(en) in de cloud.`;

    if (!docs.length) {
      list.innerHTML = `<li class="muted">Nog geen recepten. Klik “Nieuw recept”.</li>`;
      return;
    }

    list.innerHTML = docs.map(d => {
      const tags = (d.tags || []).slice(0, 6);
      const tagsHtml = tags.map(t => `<span class="badge">${escapeHtml(t)}</span>`).join("");
      const updated = d.updated_at ? new Date(d.updated_at).toLocaleString() : "";
      const hasFile = !!(d.file_path && String(d.file_path).trim());
      const hasDrive = !!(d.drive_url && String(d.drive_url).trim());

      return `
        <li class="item">
          <div class="itemTop">
            <div>
              <strong>${escapeHtml(d.title || "(zonder titel)")}</strong>
              <div class="muted">Laatst aangepast: ${escapeHtml(updated)}</div>
              <div class="badges">${tagsHtml}</div>
            </div>
            <div class="actions">
              <button class="btn small secondary" data-open="${d.id}">Open</button>
              ${hasFile ? `<button class="btn small secondary" data-openfile="${d.id}">Open document</button>` : ``}
              ${hasDrive ? `<button class="btn small secondary" data-opendrive="${d.id}">Drive</button>` : ``}
            </div>
          </div>
        </li>
      `;
    }).join("");
  } catch (e) {
    meta.textContent = "Fout bij laden.";
    list.innerHTML = "";
    setStatus("Laden mislukt: " + (e?.message || e), "err");
  }
}

function renderSearchResults(hits, label) {
  const meta = document.getElementById("resultsMeta");
  const list = document.getElementById("resultsList");

  meta.textContent = label || "";
  if (!hits.length) {
    list.innerHTML = `<li class="muted">Geen resultaten.</li>`;
    return;
  }

  list.innerHTML = hits.map(d => `
    <li class="item">
      <div class="itemTop">
        <div>
          <strong>${escapeHtml(d.title || "(zonder titel)")}</strong>
          <div class="muted">${escapeHtml(tagsToText(d.tags || []))}</div>
        </div>
        <div class="actions">
          <button class="btn small secondary" data-open="${d.id}">Open</button>
        </div>
      </div>
    </li>
  `).join("");
}

// ==============================
// Search
// ==============================
async function runTagSearch() {
  const q = document.getElementById("searchInput").value.trim().toLowerCase();

  if (!currentUser) {
    renderSearchResults([], "Login om te zoeken.");
    return;
  }
  if (!q) {
    document.getElementById("resultsMeta").textContent = "";
    document.getElementById("resultsList").innerHTML = "";
    return;
  }

  const docs = cacheRecipes.length ? cacheRecipes : await fetchRecipes();
  const hits = docs.filter(d => {
    const tags = (d.tags || []).map(t => String(t).toLowerCase());
    return tags.some(t => t.includes(q));
  });

  renderSearchResults(hits, `${hits.length} resultaat/resultaten voor tag "${q}".`);
}

async function runTitleSearch() {
  const q = document.getElementById("titleSearchInput").value.trim();

  if (!currentUser) {
    renderSearchResults([], "Login om te zoeken.");
    return;
  }
  if (!q) {
    document.getElementById("resultsMeta").textContent = "";
    document.getElementById("resultsList").innerHTML = "";
    return;
  }

  try {
    setStatus("Zoeken in titels…", "muted");
    const { data, error } = await sb
      .from("recipes")
      .select("id,title,tags,file_path,file_name,mime_type,drive_url,updated_at")
      .ilike("title", `%${q}%`)
      .order("updated_at", { ascending: false });

    if (error) throw error;

    renderSearchResults(data || [], `${(data || []).length} resultaat/resultaten voor titel "${q}".`);
    setStatus("", "muted");
  } catch (e) {
    setStatus("Titel-zoek fout: " + (e?.message || e), "err");
  }
}

function saveFavoriteSearch() {
  if (!currentUser) return setStatus("Login om favorieten te bewaren.", "err");

  const q = document.getElementById("searchInput").value.trim();
  const name = document.getElementById("favName").value.trim();
  if (!q) return setStatus("Vul eerst een tags-zoekterm in.", "err");
  if (!name) return setStatus("Geef een naam voor je favoriet.", "err");

  const favs = loadFavs();
  favs.unshift({ name, q, ts: Date.now() });
  saveFavs(favs.slice(0, 50));
  document.getElementById("favName").value = "";
  renderFavs();
  setStatus("Favoriet opgeslagen.", "ok");
}

// ==============================
// CSV import (eenvoudig)
// ==============================
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && next === '"') { cur += '"'; i++; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }

    if (!inQuotes && ch === ",") { row.push(cur); cur = ""; continue; }

    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cur); cur = "";
      if (row.some(c => String(c).trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    cur += ch;
  }

  if (cur.length || row.length) {
    row.push(cur);
    if (row.some(c => String(c).trim() !== "")) rows.push(row);
  }

  return rows;
}

async function importCsvText(csvText) {
  if (!currentUser) return setStatus("Login om te importeren.", "err");

  const rows = parseCsv(csvText);
  if (rows.length < 2) return setStatus("CSV bevat geen data.", "err");

  const header = rows[0].map(h => String(h || "").trim().toLowerCase());
  const iTitle = header.indexOf("title");
  const iTags = header.indexOf("tags");
  const iUrl = header.indexOf("drive_url");

  if (iTitle === -1) {
    return setStatus('CSV moet minstens een kolom "title" hebben (en optioneel "tags" en/of "drive_url").', "err");
  }

  const existingTitles = new Set((cacheRecipes || []).map(r => String(r.title || "").trim().toLowerCase()).filter(Boolean));
  const inserts = [];

  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r] || [];
    const title = String(cols[iTitle] || "").trim();
    const driveUrl = iUrl === -1 ? "" : String(cols[iUrl] || "").trim();
    const tags = iTags === -1 ? [] : normalizeTagsInput(String(cols[iTags] || ""));

    if (!title) continue;
    if (existingTitles.has(title.toLowerCase())) continue;

    inserts.push({
      user_id: currentUser.id,
      title,
      tags,
      drive_url: driveUrl || null,
      updated_at: new Date().toISOString()
    });

    existingTitles.add(title.toLowerCase());
  }

  if (!inserts.length) return setStatus("Geen nieuwe rijen om te importeren (of alles waren dubbels).", "muted");

  const btn = document.getElementById("btnImport");
  btn.disabled = true;

  try {
    setStatus(`Import bezig…`, "muted");
    const { error } = await sb.from("recipes").insert(inserts);
    if (error) throw error;

    setStatus(`Import klaar: ${inserts.length} recepten toegevoegd.`, "ok");
    await renderDocs();
  } catch (e) {
    setStatus("Import fout: " + (e?.message || e), "err");
  } finally {
    btn.disabled = false;
    document.getElementById("csvFile").value = "";
  }
}

// ==============================
// Delegation voor knoppen in lijsten
// ==============================
function wireListsDelegation() {
  // Zoekresultaten: Open
  document.getElementById("resultsList").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-open]");
    if (!btn) return;

    try {
      const id = btn.getAttribute("data-open");
      setStatus("Recept laden…", "muted");
      const doc = await loadRecipe(id);
      if (!doc) return;

      currentRecipeId = doc.id;
      currentRecipe = doc;

      document.getElementById("editorTitle").textContent = `Editor (ID: ${doc.id})`;
      document.getElementById("title").value = doc.title || "";
      document.getElementById("tags").value = tagsToText(doc.tags || []);
      document.getElementById("driveUrl").value = doc.drive_url || "";
      document.getElementById("docFile").value = "";

      updateEditorDocControls();
      setStatus("", "muted");
    } catch (err) {
      setStatus("Openen mislukt: " + (err?.message || err), "err");
    }
  });

  // Receptenlijst: Open, Open document, Drive
  document.getElementById("docsList").addEventListener("click", async (e) => {
    const openBtn = e.target.closest("button[data-open]");
    const openFileBtn = e.target.closest("button[data-openfile]");
    const openDriveBtn = e.target.closest("button[data-opendrive]");
    if (!openBtn && !openFileBtn && !openDriveBtn) return;

    try {
      if (openBtn) {
        const id = openBtn.getAttribute("data-open");
        setStatus("Recept laden…", "muted");
        const doc = await loadRecipe(id);
        if (!doc) return;

        currentRecipeId = doc.id;
        currentRecipe = doc;

        document.getElementById("editorTitle").textContent = `Editor (ID: ${doc.id})`;
        document.getElementById("title").value = doc.title || "";
        document.getElementById("tags").value = tagsToText(doc.tags || []);
        document.getElementById("driveUrl").value = doc.drive_url || "";
        document.getElementById("docFile").value = "";

        updateEditorDocControls();
        setStatus("", "muted");
        return;
      }

      if (openFileBtn) {
        const id = openFileBtn.getAttribute("data-openfile");
        const r =
          (currentRecipe && String(currentRecipe.id) === String(id))
            ? currentRecipe
            : await loadRecipe(id);
        await openRecipeDocument(r);
        return;
      }

      if (openDriveBtn) {
        const id = openDriveBtn.getAttribute("data-opendrive");
        const r =
          (currentRecipe && String(currentRecipe.id) === String(id))
            ? currentRecipe
            : await loadRecipe(id);

        const url = toDriveOpenUrl(r?.drive_url);
        if (!url) return setStatus("Geen Drive-link aanwezig.", "muted");
        window.open(url, "_blank", "noopener");
      }
    } catch (err) {
      setStatus("Actie mislukt: " + (err?.message || err), "err");
    }
  });
}

// ==============================
// Service worker (optioneel)
// ==============================
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch {
    // negeren
  }
}

// ==============================
// Boot
// ==============================
window.addEventListener("DOMContentLoaded", async () => {
  await registerServiceWorker();

  // Delegation
  wireListsDelegation();
  wireFavoritesDelegation();

  // Auth buttons
  document.getElementById("btnLogin").addEventListener("click", loginWithMagicLink);
  document.getElementById("btnLogout").addEventListener("click", logout);

  // New/Clear
  document.getElementById("btnNew").addEventListener("click", () => {
    clearEditor();
    setStatus("Nieuw recept: vul velden in en klik Opslaan.", "muted");
  });

  document.getElementById("btnClear").addEventListener("click", () => {
    clearEditor();
    setStatus("Leeggemaakt.", "muted");
  });

  // Search
  document.getElementById("btnSearch").addEventListener("click", runTagSearch);
  document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runTagSearch();
  });

  document.getElementById("btnTitleSearch").addEventListener("click", runTitleSearch);
  document.getElementById("titleSearchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runTitleSearch();
  });

  // Favorites
  document.getElementById("btnSaveFav").addEventListener("click", saveFavoriteSearch);

  // CSV
  document.getElementById("btnImport").addEventListener("click", () => document.getElementById("csvFile").click());
  document.getElementById("csvFile").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    await importCsvText(text);
  });

  // Editor controls
  document.getElementById("docFile").addEventListener("change", () => updateEditorDocControls());

  document.getElementById("btnOpenDoc").addEventListener("click", async () => {
    try {
      if (!currentUser) return setStatus("Login om documenten te openen.", "err");
      if (!currentRecipeId) return setStatus("Open eerst een recept.", "err");
      const r = currentRecipe || (await loadRecipe(currentRecipeId));
      await openRecipeDocument(r);
    } catch (e) {
      setStatus("Openen mislukt: " + (e?.message || e), "err");
    }
  });

  // NIEUW: Drive knop in editor (altijd tonen als drive_url bestaat)
  document.getElementById("btnOpenDrive").addEventListener("click", async () => {
    try {
      if (!currentRecipeId) return setStatus("Open eerst een recept.", "err");
      const r = currentRecipe || (await loadRecipe(currentRecipeId));
      const url = toDriveOpenUrl(r?.drive_url);
      if (!url) return setStatus("Geen Drive-link aanwezig voor dit recept.", "muted");
      window.open(url, "_blank", "noopener");
    } catch (e) {
      setStatus("Drive openen mislukt: " + (e?.message || e), "err");
    }
  });

  document.getElementById("btnRemoveDoc").addEventListener("click", async () => {
    try {
      if (!currentUser) return setStatus("Login om te wijzigen.", "err");
      if (!currentRecipeId) return setStatus("Open eerst een recept.", "err");
      const r = currentRecipe || (await loadRecipe(currentRecipeId));
      if (!r?.file_path) return setStatus("Er is geen document gekoppeld.", "muted");
      if (!confirm("Gekoppeld document verwijderen?")) return;

      setStatus("Document verwijderen…", "muted");
      await removeRecipeDocument(r);
      currentRecipe = { ...(r || {}), file_path: null, file_name: null, mime_type: null };
      updateEditorDocControls();
      await renderDocs();
      setStatus("Document verwijderd.", "ok");
    } catch (e) {
      setStatus("Verwijderen mislukt: " + (e?.message || e), "err");
    }
  });

  // Save
  document.getElementById("btnSave").addEventListener("click", async () => {
    try {
      if (!currentUser) return setStatus("Login om op te slaan.", "err");

      const title = document.getElementById("title").value.trim();
      const tags = normalizeTagsInput(document.getElementById("tags").value);
      const drive_url = document.getElementById("driveUrl").value.trim();
      const file = document.getElementById("docFile").files?.[0] || null;

      if (!title) return setStatus("Titel is verplicht.", "err");

      const hasExistingFile = !!(currentRecipe?.file_path && String(currentRecipe.file_path).trim());
      if (!file && !hasExistingFile) {
        return setStatus("Kies een document om te uploaden (of open een bestaand recept met document).", "err");
      }

      setStatus("Opslaan…", "muted");

      // 1) upsert recipe
      const id = await upsertRecipe({ title, tags, drive_url });
      currentRecipeId = id;
      setStatus("Recept opgeslagen.", "muted");

      // 2) upload if needed
      if (file) {
        setStatus("Uploaden naar cloud storage…", "muted");
        const info = await uploadAndAttachDocument({ recipeId: id, file });
        currentRecipe = {
          ...(currentRecipe || {}),
          id, title, tags,
          drive_url: drive_url || null,
          ...info
        };
      } else {
        currentRecipe = { ...(currentRecipe || {}), id, title, tags, drive_url: drive_url || null };
      }

      document.getElementById("editorTitle").textContent = `Editor (ID: ${id})`;
      document.getElementById("docFile").value = "";
      document.getElementById("driveUrl").value = drive_url; // blijft zichtbaar
      updateEditorDocControls();

      await renderDocs();
      setStatus("Opgeslagen.", "ok");
    } catch (e) {
      setStatus("Opslaan mislukt: " + (e?.message || e), "err");
    }
  });

  // Delete
  document.getElementById("btnDelete").addEventListener("click", async () => {
    try {
      if (!currentUser) return setStatus("Login om te verwijderen.", "err");
      if (!currentRecipeId) return setStatus("Open eerst een recept om te verwijderen.", "err");
      if (!confirm("Dit recept verwijderen?")) return;

      setStatus("Verwijderen…", "muted");
      await deleteRecipe();

      clearEditor();
      await renderDocs();
      setStatus("Verwijderd.", "ok");
    } catch (e) {
      setStatus("Verwijderen mislukt: " + (e?.message || e), "err");
    }
  });

  // Auth state
  await refreshAuth();
  sb.auth.onAuthStateChange(async () => {
    await refreshAuth();
    await renderDocs();
  });

  await renderDocs();
  updateEditorDocControls();
  setStatus("", "muted");
});
