// ==============================
// Supabase config
// ==============================
const SUPABASE_URL = "https://bduuymwmpjxnkhunreyl.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkdXV5bXdtcGp4bmtodW5yZXlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzMDEzNTMsImV4cCI6MjA4NTg3NzM1M30.jD64IVrN3e9Qjb9Xq1PzMQxplhLmM5FCOtV31gfE8Sc"; // <-- vul jouw ANON KEY in

const STORAGE_BUCKET = "recipe_docs";
const SIGNED_URL_TTL_SECONDS = 60;

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ==============================
// DOM helpers
// ==============================
function el(id) { return document.getElementById(id); }

function setStatus(msg, kind = "") {
  const s = el("status");
  if (!s) return;
  s.textContent = msg || "";
  s.className = "status " + (kind || "muted");
}

function setAuthInfo(msg) {
  const a = el("authInfo");
  if (a) a.textContent = msg;
}

window.addEventListener("error", (e) => setStatus("JS fout: " + (e?.message || e), "err"));
window.addEventListener("unhandledrejection", (e) => {
  const msg = e?.reason?.message || String(e?.reason || e);
  setStatus("Async fout: " + msg, "err");
});

// ==============================
// State
// ==============================
let currentUser = null;
let currentWorkspaceId = null;
let currentRole = null; // 'owner' | 'member'
let currentRecipeId = null;
let currentRecipe = null;
let cacheRecipes = [];

// ==============================
// Utils
// ==============================
function normalizeTagsInput(str) {
  return (str || "")
    .split(",")
    .map((s) => s.trim())
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
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function inferContentType(file) {
  return file?.type || "application/octet-stream";
}

function toDriveOpenUrl(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  const m1 = s.match(/\/d\/([^/]+)/);
  if (m1 && m1[1]) return `https://drive.google.com/open?id=${m1[1]}`;
  const m2 = s.match(/[?&]id=([^&]+)/);
  if (m2 && m2[1]) return `https://drive.google.com/open?id=${m2[1]}`;
  return s;
}

function buildStoragePath({ workspaceId, recipeId, fileName }) {
  const cleanName = String(fileName || "document").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${workspaceId}/${recipeId}/${safeUuid()}_${cleanName}`;
}

function requireWorkspace() {
  if (!currentUser) throw new Error("Niet ingelogd.");
  if (!currentWorkspaceId) throw new Error("Geen workspace gevonden voor dit account.");
}

function findCachedRecipeById(id) {
  return (cacheRecipes || []).find((r) => String(r.id) === String(id)) || null;
}

// ==============================
// Auth (email + password)
// ==============================
async function loginWithPassword() {
  const email = (el("email")?.value || "").trim();
  const password = (el("password")?.value || "").trim();
  if (!email || !password) return setStatus("Vul email en wachtwoord in.", "err");

  try {
    setStatus("Inloggen…", "muted");
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    setStatus("Ingelogd.", "ok");
  } catch (e) {
    setStatus("Login fout: " + (e?.message || e), "err");
  }
}

async function registerWithPassword() {
  const email = (el("email")?.value || "").trim();
  const password = (el("password")?.value || "").trim();
  if (!email || !password) return setStatus("Vul email en wachtwoord in.", "err");

  try {
    setStatus("Account aanmaken…", "muted");
    const { error } = await sb.auth.signUp({ email, password });
    if (error) throw error;
    setStatus("Account aangemaakt. Je kan nu inloggen.", "ok");
  } catch (e) {
    setStatus("Registratie fout: " + (e?.message || e), "err");
  }
}

async function logout() {
  try {
    await sb.auth.signOut();
    window.location.replace(window.location.pathname + window.location.search);
  } catch (e) {
    setStatus("Logout fout: " + (e?.message || e), "err");
  }
}

// ==============================
// Workspace + role
// ==============================
async function loadMyWorkspaceAndRole() {
  const { data, error } = await sb
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return { workspace_id: data?.workspace_id || null, role: data?.role || null };
}

function updateAdminVisibility() {
  const btnAdmin = el("btnAdmin");
  const panel = el("adminPanel");
  if (!btnAdmin || !panel) return;

  const isOwner = currentRole === "owner";
  btnAdmin.style.display = isOwner ? "" : "none";

  if (!isOwner) panel.style.display = "none";
}

async function refreshAuth() {
  const { data } = await sb.auth.getSession();
  currentUser = data?.session?.user || null;

  const btnLogout = el("btnLogout");
  if (currentUser) {
    if (btnLogout) btnLogout.style.display = "";
    setAuthInfo(`Ingelogd als ${currentUser.email}`);

    try {
      const ws = await loadMyWorkspaceAndRole();
      currentWorkspaceId = ws.workspace_id;
      currentRole = ws.role;

      if (!currentWorkspaceId) {
        setStatus("Je bent ingelogd, maar dit account is nog niet toegevoegd aan een workspace.", "err");
      } else {
        setStatus("", "muted");
      }
    } catch (e) {
      currentWorkspaceId = null;
      currentRole = null;
      setStatus("Workspace ophalen mislukt: " + (e?.message || e), "err");
    }
  } else {
    if (btnLogout) btnLogout.style.display = "none";
    setAuthInfo("Niet ingelogd");
    currentWorkspaceId = null;
    currentRole = null;
  }

  updateAdminVisibility();
  renderFavs();
  updateEditorDocControls();
}

// ==============================
// Admin actions (Edge Function)
// ==============================
function openAdminPanel() {
  const panel = el("adminPanel");
  if (panel) panel.style.display = "";
}
function closeAdminPanel() {
  const panel = el("adminPanel");
  if (panel) panel.style.display = "none";
}

async function adminAddUser() {
  requireWorkspace();
  if (currentRole !== "owner") throw new Error("Alleen owners mogen users toevoegen.");

  const email = (el("adminEmail")?.value || "").trim();
  const password = (el("adminPassword")?.value || "").trim();
  const role = (el("adminRole")?.value || "member").trim();

  if (!email) return setStatus("Admin: vul een e-mail in.", "err");
  if (role !== "member" && role !== "owner") return setStatus("Admin: ongeldige rol.", "err");

  try {
    setStatus("Admin: user toevoegen…", "muted");

    const { data, error } = await sb.functions.invoke("add-user-to-workspace", {
      body: {
        workspace_id: currentWorkspaceId,
        email,
        password: password || null,
        role
      }
    });

    if (error) throw error;
    if (data?.ok) {
      setStatus(`Admin: ${email} toegevoegd (${role}).`, "ok");
      if (el("adminPassword")) el("adminPassword").value = "";
    } else {
      throw new Error(data?.error || "Onbekende fout in Edge Function.");
    }
  } catch (e) {
    setStatus("Admin fout: " + (e?.message || e), "err");
  }
}

// ==============================
// Favorites (localStorage) - per workspace
// ==============================
function favKey() { return `recepten_favs_${currentWorkspaceId || "no_ws"}`; }

function loadFavs() {
  try { return JSON.parse(localStorage.getItem(favKey()) || "[]"); }
  catch { return []; }
}

function saveFavs(favs) {
  localStorage.setItem(favKey(), JSON.stringify(favs || []));
}

function renderFavs() {
  const list = el("favList");
  if (!list) return;

  if (!currentUser) {
    list.innerHTML = `<li class="muted">Login om favorieten te zien.</li>`;
    return;
  }
  if (!currentWorkspaceId) {
    list.innerHTML = `<li class="muted">Geen workspace: favorieten zijn uitgeschakeld.</li>`;
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
  const favList = el("favList");
  if (!favList) return;

  favList.addEventListener("click", (e) => {
    const runBtn = e.target.closest("button[data-fav-run]");
    const delBtn = e.target.closest("button[data-fav-del]");
    if (!runBtn && !delBtn) return;

    if (runBtn) {
      const i = Number(runBtn.getAttribute("data-fav-run"));
      const f = loadFavs()[i];
      if (el("searchInput")) el("searchInput").value = f?.q || "";
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
  if (!currentUser || !currentWorkspaceId) {
    cacheRecipes = [];
    return [];
  }

  const { data, error } = await sb
    .from("recipes")
    .select("id,title,tags,file_path,file_name,mime_type,drive_url,updated_at,workspace_id")
    .eq("workspace_id", currentWorkspaceId)
    .order("updated_at", { ascending: false });

  if (error) throw error;
  cacheRecipes = data || [];
  return cacheRecipes;
}

async function upsertRecipe(payload) {
  requireWorkspace();
  const nowIso = new Date().toISOString();

  if (currentRecipeId) {
    const { error } = await sb
      .from("recipes")
      .update({
        title: payload.title,
        tags: payload.tags,
        drive_url: payload.drive_url ?? null,
        updated_at: nowIso,
      })
      .eq("id", currentRecipeId)
      .eq("workspace_id", currentWorkspaceId);

    if (error) throw error;
    return currentRecipeId;
  } else {
    const { data, error } = await sb
      .from("recipes")
      .insert({
        user_id: currentUser.id,
        workspace_id: currentWorkspaceId,
        title: payload.title,
        tags: payload.tags,
        drive_url: payload.drive_url ?? null,
        updated_at: nowIso,
      })
      .select("id")
      .single();

    if (error) throw error;
    return data.id;
  }
}

async function deleteRecipe() {
  requireWorkspace();
  if (!currentRecipeId) return;

  try {
    const r = currentRecipe || findCachedRecipeById(currentRecipeId);
    if (r?.file_path) await sb.storage.from(STORAGE_BUCKET).remove([r.file_path]);
  } catch {}

  const { error } = await sb
    .from("recipes")
    .delete()
    .eq("id", currentRecipeId)
    .eq("workspace_id", currentWorkspaceId);

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
  requireWorkspace();
  if (!recipe?.file_path) return;

  const { error: delErr } = await sb.storage.from(STORAGE_BUCKET).remove([recipe.file_path]);
  if (delErr) throw delErr;

  const { error: updErr } = await sb
    .from("recipes")
    .update({ file_path: null, file_name: null, mime_type: null, updated_at: new Date().toISOString() })
    .eq("id", recipe.id)
    .eq("workspace_id", currentWorkspaceId);

  if (updErr) throw updErr;
}

async function uploadAndAttachDocument({ recipeId, file }) {
  requireWorkspace();
  if (!recipeId) throw new Error("Geen recept-ID.");
  if (!file) throw new Error("Geen bestand gekozen.");

  try {
    const existing = currentRecipe || findCachedRecipeById(recipeId);
    if (existing?.file_path) await sb.storage.from(STORAGE_BUCKET).remove([existing.file_path]);
  } catch {}

  let path = buildStoragePath({ workspaceId: currentWorkspaceId, recipeId, fileName: file.name });
  const contentType = inferContentType(file);

  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await sb.storage.from(STORAGE_BUCKET).upload(path, file, { contentType, upsert: false });
    if (!error) break;

    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("already exists")) {
      path = buildStoragePath({ workspaceId: currentWorkspaceId, recipeId, fileName: file.name });
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
      updated_at: new Date().toISOString(),
    })
    .eq("id", recipeId)
    .eq("workspace_id", currentWorkspaceId);

  if (updErr) throw updErr;

  return { file_path: path, file_name: file.name || null, mime_type: contentType || null };
}

// ==============================
// UI
// ==============================
function updateEditorDocControls() {
  const openBtn = el("btnOpenDoc");
  const rmBtn = el("btnRemoveDoc");
  const driveBtn = el("btnOpenDrive");
  const hint = el("docHint");

  const hasFile = !!(currentRecipe?.file_path && String(currentRecipe.file_path).trim());
  const hasDrive = !!(currentRecipe?.drive_url && String(currentRecipe.drive_url).trim());

  if (openBtn) openBtn.style.display = hasFile ? "" : "none";
  if (rmBtn) rmBtn.style.display = hasFile ? "" : "none";
  if (driveBtn) driveBtn.style.display = hasDrive ? "" : "none";

  if (!hint) return;
  if (!currentUser) { hint.textContent = "Login om documenten te beheren."; return; }
  if (!currentWorkspaceId) { hint.textContent = "Je account zit nog niet in een workspace."; return; }
  if (!currentRecipeId) { hint.textContent = "Je kan opslaan zonder bestand. Kies enkel een file als je wil uploaden/vervangen."; return; }

  if (hasFile) hint.textContent = `Gekoppeld document: ${currentRecipe.file_name || "(document)"} (openen/vervangen kan).`;
  else hint.textContent = "Geen document gekoppeld. Dat is ok; je kan later uploaden.";
}

function clearEditor() {
  currentRecipeId = null;
  currentRecipe = null;

  if (el("editorTitle")) el("editorTitle").textContent = "Editor";
  if (el("title")) el("title").value = "";
  if (el("tags")) el("tags").value = "";
  if (el("driveUrl")) el("driveUrl").value = "";
  if (el("docFile")) el("docFile").value = "";

  updateEditorDocControls();
}

async function renderDocs() {
  const meta = el("docsMeta");
  const list = el("docsList");
  if (!meta || !list) return;

  if (!currentUser) { meta.textContent = "Login om je recepten te zien."; list.innerHTML = ""; return; }
  if (!currentWorkspaceId) { meta.textContent = "Je account zit nog niet in een workspace."; list.innerHTML = ""; return; }

  try {
    const docs = await fetchRecipes();
    meta.textContent = `${docs.length} recept(en) in de cloud (workspace).`;

    if (!docs.length) {
      list.innerHTML = `<li class="muted">Nog geen recepten. Klik “Nieuw recept”.</li>`;
      return;
    }

    list.innerHTML = docs.map((d) => {
      const tags = (d.tags || []).slice(0, 6);
      const tagsHtml = tags.map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join("");
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
  const meta = el("resultsMeta");
  const list = el("resultsList");
  if (!meta || !list) return;

  meta.textContent = label || "";
  if (!hits.length) { list.innerHTML = `<li class="muted">Geen resultaten.</li>`; return; }

  list.innerHTML = hits.map((d) => `
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
// - tags input: "pasta, snel" => AND match
// ==============================
async function runTagSearch() {
  const raw = (el("searchInput")?.value || "").trim().toLowerCase();

  if (!currentUser) return renderSearchResults([], "Login om te zoeken.");
  if (!currentWorkspaceId) return renderSearchResults([], "Geen workspace: zoekfunctie is uitgeschakeld.");
  if (!raw) return renderSearchResults([], "");

  const wanted = raw.split(",").map(s => s.trim()).filter(Boolean); // AND tags
  const docs = cacheRecipes.length ? cacheRecipes : await fetchRecipes();

  const hits = docs.filter((d) => {
    const tags = (d.tags || []).map(t => String(t).toLowerCase());
    return wanted.every(w => tags.some(t => t.includes(w)));
  });

  renderSearchResults(hits, `${hits.length} resultaat/resultaten voor tag(s) "${raw}".`);
}

async function runTitleSearch() {
  const qRaw = (el("titleSearchInput")?.value || "").trim();
  if (!currentUser) return renderSearchResults([], "Login om te zoeken.");
  if (!currentWorkspaceId) return renderSearchResults([], "Geen workspace: zoekfunctie is uitgeschakeld.");
  if (!qRaw) return renderSearchResults([], "");

  const q = qRaw.toLowerCase();
  const docs = cacheRecipes.length ? cacheRecipes : await fetchRecipes();
  const hits = docs.filter((d) => String(d.title || "").toLowerCase().includes(q));

  renderSearchResults(hits, `${hits.length} resultaat/resultaten voor titel "${qRaw}".`);
}

function saveFavoriteSearch() {
  if (!currentUser) return setStatus("Login om favorieten te bewaren.", "err");
  if (!currentWorkspaceId) return setStatus("Geen workspace: favorieten zijn uitgeschakeld.", "err");

  const q = (el("searchInput")?.value || "").trim();
  const name = (el("favName")?.value || "").trim();
  if (!q) return setStatus("Vul eerst een tags-zoekterm in.", "err");
  if (!name) return setStatus("Geef een naam voor je favoriet.", "err");

  const favs = loadFavs();
  favs.unshift({ name, q, ts: Date.now() });
  saveFavs(favs.slice(0, 50));
  if (el("favName")) el("favName").value = "";
  renderFavs();
  setStatus("Favoriet opgeslagen.", "ok");
}

// ==============================
// Open in editor
// ==============================
function openRecipeInEditor(id) {
  const r = findCachedRecipeById(id);
  if (!r) return setStatus("Recept niet gevonden. Herlaad de lijst.", "err");

  currentRecipeId = r.id;
  currentRecipe = r;

  if (el("editorTitle")) el("editorTitle").textContent = `Editor (ID: ${r.id})`;
  if (el("title")) el("title").value = r.title || "";
  if (el("tags")) el("tags").value = tagsToText(r.tags || []);
  if (el("driveUrl")) el("driveUrl").value = r.drive_url || "";
  if (el("docFile")) el("docFile").value = "";

  updateEditorDocControls();
  setStatus("", "muted");
}

// ==============================
// Click delegation
// ==============================
function wireListsDelegation() {
  const resultsList = el("resultsList");
  const docsList = el("docsList");

  if (resultsList) {
    resultsList.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-open]");
      if (!btn) return;
      openRecipeInEditor(btn.getAttribute("data-open"));
    });
  }

  if (docsList) {
    docsList.addEventListener("click", async (e) => {
      const openBtn = e.target.closest("button[data-open]");
      const driveBtn = e.target.closest("button[data-opendrive]");
      const fileBtn = e.target.closest("button[data-openfile]");
      if (!openBtn && !driveBtn && !fileBtn) return;

      try {
        if (openBtn) { openRecipeInEditor(openBtn.getAttribute("data-open")); return; }
        if (driveBtn) {
          const r = findCachedRecipeById(driveBtn.getAttribute("data-opendrive"));
          const url = toDriveOpenUrl(r?.drive_url);
          if (!url) return setStatus("Geen Drive-link aanwezig.", "muted");
          window.open(url, "_blank", "noopener");
          return;
        }
        if (fileBtn) {
          const r = findCachedRecipeById(fileBtn.getAttribute("data-openfile"));
          await openRecipeDocument(r);
        }
      } catch (err) {
        setStatus("Actie mislukt: " + (err?.message || err), "err");
      }
    });
  }
}

// ==============================
// Service worker
// ==============================
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("./sw.js"); } catch {}
}

// ==============================
// Boot
// ==============================
window.addEventListener("DOMContentLoaded", async () => {
  await registerServiceWorker();

  wireListsDelegation();
  wireFavoritesDelegation();

  // Auth
  el("btnLogin")?.addEventListener("click", loginWithPassword);
  el("btnRegister")?.addEventListener("click", registerWithPassword);
  el("btnLogout")?.addEventListener("click", logout);

  // Admin
  el("btnAdmin")?.addEventListener("click", openAdminPanel);
  el("btnAdminClose")?.addEventListener("click", closeAdminPanel);
  el("btnAdminAdd")?.addEventListener("click", adminAddUser);

  // Editor basics
  el("btnNew")?.addEventListener("click", () => { clearEditor(); setStatus("Nieuw recept: vul velden in en klik Opslaan.", "muted"); });
  el("btnClear")?.addEventListener("click", () => { clearEditor(); setStatus("Leeggemaakt.", "muted"); });

  // Search
  el("btnSearch")?.addEventListener("click", runTagSearch);
  el("searchInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") runTagSearch(); });

  el("btnTitleSearch")?.addEventListener("click", runTitleSearch);
  el("titleSearchInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") runTitleSearch(); });

  // Favorites
  el("btnSaveFav")?.addEventListener("click", saveFavoriteSearch);

  // Doc buttons
  el("btnOpenDoc")?.addEventListener("click", async () => {
    try {
      requireWorkspace();
      if (!currentRecipeId) return setStatus("Open eerst een recept.", "err");
      await openRecipeDocument(currentRecipe || findCachedRecipeById(currentRecipeId));
    } catch (e) {
      setStatus("Openen mislukt: " + (e?.message || e), "err");
    }
  });

  el("btnOpenDrive")?.addEventListener("click", async () => {
    try {
      if (!currentRecipeId) return setStatus("Open eerst een recept.", "err");
      const r = currentRecipe || findCachedRecipeById(currentRecipeId);
      const url = toDriveOpenUrl(r?.drive_url);
      if (!url) return setStatus("Geen Drive-link aanwezig.", "muted");
      window.open(url, "_blank", "noopener");
    } catch (e) {
      setStatus("Drive openen mislukt: " + (e?.message || e), "err");
    }
  });

  el("btnRemoveDoc")?.addEventListener("click", async () => {
    try {
      requireWorkspace();
      if (!currentRecipeId) return setStatus("Open eerst een recept.", "err");
      const r = currentRecipe || findCachedRecipeById(currentRecipeId);
      if (!r?.file_path) return setStatus("Er is geen document gekoppeld.", "muted");
      if (!confirm("Gekoppeld document verwijderen?")) return;

      setStatus("Document verwijderen…", "muted");
      await removeRecipeDocument(r);

      const updated = { ...(r || {}), file_path: null, file_name: null, mime_type: null, updated_at: new Date().toISOString() };
      cacheRecipes = cacheRecipes.map((x) => (String(x.id) === String(updated.id) ? updated : x));
      currentRecipe = updated;

      updateEditorDocControls();
      await renderDocs();
      setStatus("Document verwijderd.", "ok");
    } catch (e) {
      setStatus("Verwijderen mislukt: " + (e?.message || e), "err");
    }
  });

  // Save (bestand is optioneel)
  el("btnSave")?.addEventListener("click", async () => {
    try {
      requireWorkspace();

      const title = (el("title")?.value || "").trim();
      const tags = normalizeTagsInput(el("tags")?.value || "");
      const drive_url = (el("driveUrl")?.value || "").trim();
      const file = el("docFile")?.files?.[0] || null;

      if (!title) return setStatus("Titel is verplicht.", "err");

      setStatus("Opslaan…", "muted");

      const id = await upsertRecipe({ title, tags, drive_url });
      currentRecipeId = id;

      let docInfo = {};
      if (file) {
        setStatus("Uploaden naar cloud storage…", "muted");
        docInfo = await uploadAndAttachDocument({ recipeId: id, file });
        if (el("docFile")) el("docFile").value = "";
      }

      const existing = findCachedRecipeById(id);
      const updated = {
        ...(existing || {}),
        id,
        title,
        tags,
        drive_url: drive_url || null,
        workspace_id: currentWorkspaceId,
        updated_at: new Date().toISOString(),
        ...(docInfo || {}),
      };

      if (!file && existing?.file_path) {
        updated.file_path = existing.file_path;
        updated.file_name = existing.file_name;
        updated.mime_type = existing.mime_type;
      }

      cacheRecipes = [updated, ...cacheRecipes.filter((r) => String(r.id) !== String(id))];
      currentRecipe = updated;

      if (el("editorTitle")) el("editorTitle").textContent = `Editor (ID: ${id})`;
      updateEditorDocControls();

      await renderDocs();
      setStatus("Opgeslagen.", "ok");
    } catch (e) {
      setStatus("Opslaan mislukt: " + (e?.message || e), "err");
    }
  });

  // Delete
  el("btnDelete")?.addEventListener("click", async () => {
    try {
      requireWorkspace();
      if (!currentRecipeId) return setStatus("Open eerst een recept om te verwijderen.", "err");
      if (!confirm("Dit recept verwijderen?")) return;

      setStatus("Verwijderen…", "muted");
      await deleteRecipe();

      cacheRecipes = cacheRecipes.filter((r) => String(r.id) !== String(currentRecipeId));
      clearEditor();
      await renderDocs();
      setStatus("Verwijderd.", "ok");
    } catch (e) {
      setStatus("Verwijderen mislukt: " + (e?.message || e), "err");
    }
  });

  // Init
  await refreshAuth();
  sb.auth.onAuthStateChange(async () => { await refreshAuth(); await renderDocs(); });
  await renderDocs();
  updateEditorDocControls();
  setStatus("", "muted");
});
