/* Recepten DB (Supabase Cloud)
   - magic link login
   - recipes table: id (bigint/uuid), user_id (uuid), title (text), tags (text[]),
     file_path (text, nullable), file_name (text, nullable), mime_type (text, nullable),
     drive_url (text, nullable, legacy), updated_at (timestamptz)
   - documenten uploaden naar Supabase Storage + openen via signed URL
   - zoeken in tags (client-side)
   - zoeken in titel (server-side ilike)
   - favoriete zoekopdrachten (localStorage)
   - CSV import (title,tags en optioneel drive_url)
*/

// ==============================
// Vul deze 2 waarden in (Supabase -> Project Settings -> API)
// ==============================
const SUPABASE_URL = "https://bduuymwmpjxnkhunreyl.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkdXV5bXdtcGp4bmtodW5yZXlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzMDEzNTMsImV4cCI6MjA4NTg3NzM1M30.jD64IVrN3e9Qjb9Xq1PzMQxplhLmM5FCOtV31gfE8Sc";

// ==============================
// Storage
// ==============================
const STORAGE_BUCKET = "recipe_docs";          // maak deze bucket aan in Supabase Storage
const SIGNED_URL_TTL_SECONDS = 60;             // hoe lang een "open"-link geldig is

// ==============================
// Init
// ==============================
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

let currentUser = null;
let currentRecipeId = null;
let currentRecipe = null; // volledige record (incl. file_path)
let cacheRecipes = []; // laatste fetch van recipes voor user

function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg || "";
  el.className = "status " + (kind || "muted");
}

function setAuthInfo(msg) {
  $("authInfo").textContent = msg;
}

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

// legacy helper (Drive)
function toPreviewUrl(url) {
  const m = String(url || "").match(/\/d\/([^/]+)/);
  if (m && m[1]) return `https://drive.google.com/open?id=${m[1]}`;
  return url || "";
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
  // per-user map + per-recipe map voorkomt botsingen en maakt policies eenvoudiger
  const cleanName = String(fileName || "document").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${userId}/${recipeId}/${safeUuid()}_${cleanName}`;
}

function updateEditorDocControls() {
  const openBtn = $("btnOpenDoc");
  const rmBtn = $("btnRemoveDoc");
  const hint = $("docHint");

  const hasFile = !!(currentRecipe?.file_path && String(currentRecipe.file_path).trim());
  openBtn.style.display = hasFile ? "" : "none";
  rmBtn.style.display = hasFile ? "" : "none";

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

  // 1) verwijder bestand
  const { error: delErr } = await sb.storage
    .from(STORAGE_BUCKET)
    .remove([recipe.file_path]);
  if (delErr) throw delErr;

  // 2) maak DB velden leeg
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

  // Als er al een document hangt, eerst verwijderen (geen orphan files)
  const existing = currentRecipe || (await loadRecipe(recipeId));
  if (existing?.file_path) {
    try {
      await sb.storage.from(STORAGE_BUCKET).remove([existing.file_path]);
    } catch {
      // negeren; we gaan toch door met upload
    }
  }

  let path = buildStoragePath({ userId: currentUser.id, recipeId, fileName: file.name });
  const contentType = inferContentType(file);

  // Upload (met eenvoudige retry bij conflict)
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

  // Koppel aan recept
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
// Favorites (localStorage) - voor tags-zoek
// ==============================
function favKey() {
  return `recepten_favs_${currentUser?.id || "anon"}`;
}

function loadFavs() {
  try {
    return JSON.parse(localStorage.getItem(favKey()) || "[]");
  } catch {
    return [];
  }
}

function saveFavs(favs) {
  localStorage.setItem(favKey(), JSON.stringify(favs || []));
}

function renderFavs() {
  const list = $("favList");
  const favs = loadFavs();

  if (!currentUser) {
    list.innerHTML = `<li class="muted">Login om favorieten te zien.</li>`;
    return;
  }
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
          <button class="btn small secondary" data-run="${idx}">Run</button>
          <button class="btn small danger" data-del="${idx}">X</button>
        </div>
      </div>
    </li>
  `).join("");

  list.querySelectorAll("button[data-run]").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.getAttribute("data-run"));
      const f = loadFavs()[i];
      $("searchInput").value = f.q;
      runTagSearch();
    });
  });

  list.querySelectorAll("button[data-del]").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.getAttribute("data-del"));
      const favs2 = loadFavs();
      favs2.splice(i, 1);
      saveFavs(favs2);
      renderFavs();
    });
  });
}

// ==============================
// Auth
// ==============================
async function refreshAuth() {
  const { data } = await sb.auth.getSession();
  currentUser = data?.session?.user || null;

  if (currentUser) {
    setAuthInfo(`Ingelogd als ${currentUser.email}`);
    $("btnLogout").style.display = "";
  } else {
    setAuthInfo("Niet ingelogd");
    $("btnLogout").style.display = "none";
  }

  renderFavs();
  updateEditorDocControls();
}

async function loginWithMagicLink() {
  const email = $("email").value.trim();
  if (!email) return setStatus("Vul je e-mailadres in.", "err");

  $("btnLogin").disabled = true;
  try {
    setStatus("Login link wordt verstuurd… (kijk ook in spam)", "muted");
    const redirectTo = window.location.origin + window.location.pathname;
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo }
    });
    if (error) throw error;
    setStatus("Mail verstuurd. Open de link in je mail om in te loggen.", "ok");
  } catch (e) {
    setStatus("Supabase error: " + (e?.message || e), "err");
  } finally {
    $("btnLogin").disabled = false;
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
        file_path: payload.file_path ?? currentRecipe?.file_path ?? null,
        file_name: payload.file_name ?? currentRecipe?.file_name ?? null,
        mime_type: payload.mime_type ?? currentRecipe?.mime_type ?? null,
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
        file_path: payload.file_path ?? null,
        file_name: payload.file_name ?? null,
        mime_type: payload.mime_type ?? null,
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

  // Eerst gekoppeld document verwijderen (als dat bestaat), zodat je geen orphan files krijgt
  try {
    const r = currentRecipe || (await loadRecipe(currentRecipeId));
    if (r?.file_path) {
      const { error: delErr } = await sb.storage.from(STORAGE_BUCKET).remove([r.file_path]);
      if (delErr) throw delErr;
    }
  } catch {
    // Als file delete faalt, stoppen we niet meteen: de DB delete is vaak belangrijker.
    // (Je kan later een cleanup job doen in Storage.)
  }

  const { error } = await sb.from("recipes").delete().eq("id", currentRecipeId);
  if (error) throw error;
}

// ==============================
// UI: render
// ==============================
async function renderDocs() {
  const meta = $("docsMeta");
  const list = $("docsList");

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
      const hasDrive = !!(d.drive_url && String(d.drive_url).trim());
      const hasFile = !!(d.file_path && String(d.file_path).trim());

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
              ${!hasFile && hasDrive ? `<a class="linkPdf" href="${escapeHtml(toPreviewUrl(d.drive_url))}" target="_blank" rel="noopener">Drive</a>` : ``}
            </div>
          </div>
        </li>
      `;
    }).join("");

    list.querySelectorAll("button[data-open]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-open");
        const doc = await loadRecipe(id);
        if (!doc) return;
        currentRecipeId = doc.id;
        currentRecipe = doc;
        $("editorTitle").textContent = `Editor (ID: ${doc.id})`;
        $("title").value = doc.title || "";
        $("tags").value = tagsToText(doc.tags || []);
        $("driveUrl").value = doc.drive_url || "";
        $("docFile").value = "";
        updateEditorDocControls();
        setStatus("", "muted");
      });
    });

    list.querySelectorAll("button[data-openfile]").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          const id = btn.getAttribute("data-openfile");
          const r = (currentRecipe && String(currentRecipe.id) === String(id))
            ? currentRecipe
            : await loadRecipe(id);
          await openRecipeDocument(r);
        } catch (e) {
          setStatus("Openen mislukt: " + (e?.message || e), "err");
        }
      });
    });
  } catch (e) {
    meta.textContent = "Fout bij laden.";
    list.innerHTML = "";
    setStatus("Laden mislukt: " + (e?.message || e), "err");
  }
}

function clearEditor() {
  currentRecipeId = null;
  currentRecipe = null;
  $("editorTitle").textContent = "Editor";
  $("title").value = "";
  $("tags").value = "";
  $("driveUrl").value = "";
  $("docFile").value = "";
  updateEditorDocControls();
}

function renderSearchResults(hits, label) {
  const meta = $("resultsMeta");
  const list = $("resultsList");

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

  list.querySelectorAll("button[data-open]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-open");
      const doc = await loadRecipe(id);
      if (!doc) return;
      currentRecipeId = doc.id;
      currentRecipe = doc;
      $("editorTitle").textContent = `Editor (ID: ${doc.id})`;
      $("title").value = doc.title || "";
      $("tags").value = tagsToText(doc.tags || []);
      $("driveUrl").value = doc.drive_url || "";
      $("docFile").value = "";
      updateEditorDocControls();
    });
  });
}

// ==============================
// Zoeken 1: tags (client-side)
// ==============================
async function runTagSearch() {
  const q = $("searchInput").value.trim().toLowerCase();

  if (!currentUser) {
    renderSearchResults([], "Login om te zoeken.");
    return;
  }
  if (!q) {
    $("resultsMeta").textContent = "";
    $("resultsList").innerHTML = "";
    return;
  }

  const docs = cacheRecipes.length ? cacheRecipes : await fetchRecipes();
  const hits = docs.filter(d => {
    const tags = (d.tags || []).map(t => String(t).toLowerCase());
    return tags.some(t => t.includes(q));
  });

  renderSearchResults(hits, `${hits.length} resultaat/resultaten voor tag "${q}".`);
}

// ==============================
// Zoeken 2: titel (server-side ilike)
// ==============================
async function runTitleSearch() {
  const q = $("titleSearchInput").value.trim();

  if (!currentUser) {
    renderSearchResults([], "Login om te zoeken.");
    return;
  }
  if (!q) {
    $("resultsMeta").textContent = "";
    $("resultsList").innerHTML = "";
    return;
  }

  try {
    const { data, error } = await sb
      .from("recipes")
      .select("id,title,tags,file_path,file_name,mime_type,drive_url,updated_at")
      .ilike("title", `%${q}%`)
      .order("updated_at", { ascending: false });

    if (error) throw error;

    const hits = data || [];
    renderSearchResults(hits, `${hits.length} resultaat/resultaten voor titel "${q}".`);
  } catch (e) {
    setStatus("Titel-zoek fout: " + (e?.message || e), "err");
  }
}

function saveFavoriteSearch() {
  if (!currentUser) return setStatus("Login om favorieten te bewaren.", "err");

  const q = $("searchInput").value.trim();
  const name = $("favName").value.trim();
  if (!q) return setStatus("Vul eerst een tags-zoekterm in.", "err");
  if (!name) return setStatus("Geef een naam voor je favoriet.", "err");

  const favs = loadFavs();
  favs.unshift({ name, q, ts: Date.now() });
  saveFavs(favs.slice(0, 50));
  $("favName").value = "";
  renderFavs();
  setStatus("Favoriet opgeslagen.", "ok");
}

// ==============================
// CSV import
// ==============================
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && next === '"') {
      cur += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === ",") {
      row.push(cur);
      cur = "";
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cur);
      cur = "";
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

  // Dedupe: als drive_url aanwezig is, dedupen we daarop; anders op titel
  const existingUrls = new Set((cacheRecipes || []).map(r => String(r.drive_url || "").trim()).filter(Boolean));
  const existingTitles = new Set((cacheRecipes || []).map(r => String(r.title || "").trim().toLowerCase()).filter(Boolean));

  const inserts = [];
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r] || [];
    const title = String(cols[iTitle] || "").trim();
    const driveUrl = iUrl === -1 ? "" : String(cols[iUrl] || "").trim();
    const tags = iTags === -1 ? [] : normalizeTagsInput(String(cols[iTags] || ""));

    if (!title) continue;
    if (driveUrl && existingUrls.has(driveUrl)) continue;
    if (!driveUrl && existingTitles.has(title.toLowerCase())) continue;

    inserts.push({
      user_id: currentUser.id,
      title,
      tags,
      drive_url: driveUrl || null,
      file_path: null,
      file_name: null,
      mime_type: null,
      updated_at: new Date().toISOString()
    });

    if (driveUrl) existingUrls.add(driveUrl);
    existingTitles.add(title.toLowerCase());
  }

  if (!inserts.length) return setStatus("Geen nieuwe rijen om te importeren (of alles waren dubbels).", "muted");

  const BATCH = 200;
  $("btnImport").disabled = true;

  let ok = 0;
  try {
    for (let i = 0; i < inserts.length; i += BATCH) {
      const chunk = inserts.slice(i, i + BATCH);
      const { error } = await sb.from("recipes").insert(chunk);
      if (error) throw error;
      ok += chunk.length;
      setStatus(`Import bezig… ${ok}/${inserts.length}`, "muted");
    }

    setStatus(`Import klaar: ${ok} recepten toegevoegd.`, "ok");
    await renderDocs();
  } catch (e) {
    setStatus("Import fout: " + (e?.message || e), "err");
  } finally {
    $("btnImport").disabled = false;
    $("csvFile").value = "";
  }
}

// ==============================
// Service Worker (optioneel)
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

  $("btnLogin").addEventListener("click", loginWithMagicLink);
  $("btnLogout").addEventListener("click", logout);

  $("btnNew").addEventListener("click", () => {
    clearEditor();
    setStatus("Nieuw recept: vul velden in en klik Opslaan.", "muted");
  });

  $("btnClear").addEventListener("click", () => {
    clearEditor();
    setStatus("Leeggemaakt.", "muted");
  });

  $("docFile").addEventListener("change", () => {
    updateEditorDocControls();
  });

  $("btnOpenDoc").addEventListener("click", async () => {
    try {
      if (!currentUser) return setStatus("Login om documenten te openen.", "err");
      if (!currentRecipeId) return setStatus("Open eerst een recept.", "err");
      const r = currentRecipe || (await loadRecipe(currentRecipeId));
      await openRecipeDocument(r);
    } catch (e) {
      setStatus("Openen mislukt: " + (e?.message || e), "err");
    }
  });

  $("btnRemoveDoc").addEventListener("click", async () => {
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

  $("btnSave").addEventListener("click", async () => {
    try {
      if (!currentUser) return setStatus("Login om op te slaan.", "err");

      const title = $("title").value.trim();
      const tags = normalizeTagsInput($("tags").value);
      const drive_url = $("driveUrl").value.trim(); // legacy/optioneel
      const file = $("docFile").files?.[0] || null;

      if (!title) return setStatus("Titel is verplicht.", "err");

      // Vereis een upload of een al gekoppeld document
      const hasExistingFile = !!(currentRecipe?.file_path && String(currentRecipe.file_path).trim());
      if (!file && !hasExistingFile) {
        return setStatus("Kies een document om te uploaden (of open een bestaand recept met document).", "err");
      }

      setStatus(file ? "Opslaan… (upload volgt)" : "Opslaan…", "muted");

      // 1) Recept opslaan/aanmaken
      const id = await upsertRecipe({ title, tags, drive_url });
      currentRecipeId = id;

      // 2) Als er een bestand gekozen is: upload en koppel
      if (file) {
        setStatus("Uploaden naar cloud storage…", "muted");
        const info = await uploadAndAttachDocument({ recipeId: id, file });
        currentRecipe = {
          ...(currentRecipe || {}),
          id,
          title,
          tags,
          drive_url: drive_url || null,
          ...info
        };
      } else {
        currentRecipe = {
          ...(currentRecipe || {}),
          id,
          title,
          tags,
          drive_url: drive_url || null
        };
      }

      $("editorTitle").textContent = `Editor (ID: ${id})`;
      $("docFile").value = "";
      updateEditorDocControls();
      setStatus("Opgeslagen.", "ok");
      await renderDocs();
    } catch (e) {
      setStatus("Opslaan mislukt: " + (e?.message || e), "err");
    }
  });

  $("btnDelete").addEventListener("click", async () => {
    try {
      if (!currentUser) return setStatus("Login om te verwijderen.", "err");
      if (!currentRecipeId) return setStatus("Open eerst een recept om te verwijderen.", "err");

      if (!confirm("Dit recept verwijderen?")) return;

      await deleteRecipe();
      clearEditor();
      setStatus("Verwijderd.", "ok");
      await renderDocs();
    } catch (e) {
      setStatus("Verwijderen mislukt: " + (e?.message || e), "err");
    }
  });

  // Tags-zoek
  $("btnSearch").addEventListener("click", runTagSearch);
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runTagSearch();
  });

  // Titel-zoek
  $("btnTitleSearch").addEventListener("click", runTitleSearch);
  $("titleSearchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runTitleSearch();
  });

  // Favorieten (voor tags-zoek)
  $("btnSaveFav").addEventListener("click", saveFavoriteSearch);

  // CSV import UI
  $("btnImport").addEventListener("click", () => $("csvFile").click());
  $("csvFile").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    await importCsvText(text);
  });

  // Auth state
  await refreshAuth();
  sb.auth.onAuthStateChange(async () => {
    await refreshAuth();
    await renderDocs();
  });

  await renderDocs();
  updateEditorDocControls();
});
