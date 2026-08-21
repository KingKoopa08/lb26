const state = { csrf: "", view: "dashboard", role: "", permissions: [] };
const analyticsStyles = document.createElement("link");
analyticsStyles.rel = "stylesheet";
analyticsStyles.href = "/admin/analytics.css";
document.head.append(analyticsStyles);
const usersStyles = document.createElement("link");
usersStyles.rel = "stylesheet";
usersStyles.href = "/admin/users.css";
document.head.append(usersStyles);
const view = document.getElementById("view");
const modal = document.getElementById("modal");
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const date = (v) =>
  v
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "America/Chicago",
      }).format(new Date(v))
    : "Not set";
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": state.csrf,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return response.headers.get("content-type")?.includes("json")
    ? response.json()
    : response.text();
}
function flash(message, error = false) {
  const el = document.getElementById("flash");
  el.className = error ? "flash error" : "flash";
  el.textContent = message;
  setTimeout(() => (el.textContent = ""), 4500);
}
function card(title, value, caption = "") {
  return `<article class="metric"><span>${esc(title)}</span><strong>${esc(value)}</strong><small>${esc(caption)}</small></article>`;
}
async function dashboard() {
  view.innerHTML = "<p>Loading dashboard…</p>";
  const d = await api("/api/admin/dashboard");
  const total = Object.values(d.newRequests).reduce((a, b) => a + b, 0);
  const unread = Number(d.email?.unread || 0);
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">OPERATIONS</p><h1>Campaign dashboard</h1></div></div><div class="metrics">${card("New requests", total, "Awaiting first action")}${card("Overdue follow-ups", d.overdue, "Needs attention")}${card("Unread emails", unread, "Open the email inbox")}${card("Unassigned emails", d.email?.unassigned || 0, "Needs an owner")}${card("Email follow-ups", d.email?.follow_up || 0, "Awaiting a reply")}</div><div class="split"><section class="panel"><h2>Recent submissions</h2>${d.recent.length ? `<div class="rows">${d.recent.map((r) => requestRow(r)).join("")}</div>` : '<p class="empty">No submissions yet.</p>'}</section><section class="panel"><h2>Unread email</h2>${d.recentEmails?.length ? d.recentEmails.map((item) => `<button class="email-row unread" data-dashboard-email="${item.id}"><span class="email-meta"><strong>${esc(item.from_address || "Unknown sender")}</strong><time>${date(item.last_message_at)}</time></span><b>${esc(item.subject)}</b></button>`).join("") : '<p class="empty">Inbox zero.</p>'}<button id="open-email" style="margin-top:14px">Open email inbox</button></section></div>`;
  bindRows();
  document.getElementById("open-email").addEventListener("click", () => {
    state.view = "email";
    email();
  });
  document.querySelectorAll("[data-dashboard-email]").forEach((row) =>
    row.addEventListener("click", async () => {
      state.view = "email";
      await email();
      emailThread(row.dataset.dashboardEmail);
    }),
  );
  const badge = document.getElementById("email-badge");
  badge.textContent = unread;
  badge.hidden = !unread;
}
function requestRow(r) {
  return `<button class="request-row" data-contact="${r.contact_id}"><span class="type type-${esc(r.request_type)}">${esc(r.request_type.replace("_", " "))}</span><span><strong>${esc(r.first_name)} ${esc(r.last_name)}</strong><small>${esc(r.email || r.phone || "")}</small></span><span class="status">${esc(r.status)}</span><time>${date(r.created_at)}</time></button>`;
}
async function requests() {
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">CRM</p><h1>Supporter inbox</h1></div></div><form class="filters" id="filters"><input name="q" placeholder="Search name, email, phone, city, ZIP"><select name="type"><option value="">All request types</option><option value="volunteer">Volunteer</option><option value="yard_sign">Yard sign</option><option value="house_party">House party</option><option value="host_event">Host event</option><option value="rsvp">RSVP</option><option value="general">General</option></select><select name="status"><option value="">All statuses</option>${["new", "contacted", "scheduled", "completed", "declined", "duplicate", "spam"].map((s) => `<option>${s}</option>`).join("")}</select><button>Filter</button></form><section class="panel"><div id="request-list">Loading…</div></section>`;
  document.getElementById("filters").addEventListener("submit", (e) => {
    e.preventDefault();
    loadRequests(new URLSearchParams(new FormData(e.target)));
  });
  await loadRequests();
}
async function loadRequests(params = new URLSearchParams()) {
  const d = await api("/api/admin/requests?" + params);
  document.getElementById("request-list").innerHTML = d.requests.length
    ? `<div class="rows">${d.requests.map(requestRow).join("")}</div>`
    : '<p class="empty">Nothing matches these filters.</p>';
  bindRows();
}
function bindRows() {
  document
    .querySelectorAll("[data-contact]")
    .forEach((el) =>
      el.addEventListener("click", () => contact(el.dataset.contact)),
    );
}
async function contact(id) {
  const d = await api(`/api/admin/contacts/${id}`);
  modal.querySelector("#modal-content").innerHTML =
    `<p class="eyebrow">CONTACT</p><h1>${esc(d.contact.first_name)} ${esc(d.contact.last_name)}</h1><div class="contact-grid"><span>${esc(d.contact.email || "No email")}</span><span>${esc(d.contact.phone || "No phone")}</span><span>${esc([d.contact.address_line1, d.contact.city, d.contact.state, d.contact.postal_code].filter(Boolean).join(", ") || "No address")}</span><span>Consent: ${d.contact.consent ? "Yes" : "No"}</span></div><h2>Engagement history</h2><div class="timeline">${d.requests.map((r) => `<article><div><span class="type">${esc(r.request_type.replace("_", " "))}</span><strong>${date(r.created_at)}</strong></div><select data-request-status="${r.id}">${["new", "contacted", "scheduled", "completed", "declined", "duplicate", "spam"].map((s) => `<option ${s === r.status ? "selected" : ""}>${s}</option>`).join("")}</select><pre>${esc(JSON.stringify(r.details, null, 2))}</pre></article>`).join("") || '<p class="empty">No requests.</p>'}</div><h2>Follow-up tasks</h2><form id="task-form" class="filters"><input name="title" required maxlength="300" placeholder="Call, deliver sign, confirm venue…"><input name="dueAt" type="datetime-local"><button>Add task</button></form><div class="notes">${d.tasks.map((t) => `<article><strong>${t.completed_at ? "Completed" : "Open"} · ${date(t.due_at)}</strong><p>${esc(t.title)}</p>${t.completed_at ? "" : `<button data-complete-task="${t.id}">Mark complete</button>`}</article>`).join("") || '<p class="empty">No follow-up tasks.</p>'}</div><h2>Internal notes</h2><form id="note-form"><textarea name="body" rows="4" maxlength="5000" required placeholder="Add a private campaign note"></textarea><button>Add note</button></form><div class="notes">${d.notes.map((n) => `<article><strong>${esc(n.author_email || "Former user")} · ${date(n.created_at)}</strong><p>${esc(n.body)}</p></article>`).join("") || '<p class="empty">No notes yet.</p>'}</div>`;
  modal.showModal();
  modal.querySelectorAll("[data-request-status]").forEach((el) =>
    el.addEventListener("change", async () => {
      try {
        await api(`/api/admin/requests/${el.dataset.requestStatus}`, {
          method: "PATCH",
          body: JSON.stringify({ status: el.value }),
        });
        flash("Request status updated.");
      } catch (e) {
        flash(e.message, true);
      }
    }),
  );
  document.querySelectorAll("[data-complete-task]").forEach((el) =>
    el.addEventListener("click", async () => {
      try {
        await api(`/api/admin/tasks/${el.dataset.completeTask}`, {
          method: "PATCH",
          body: JSON.stringify({ completed: true }),
        });
        contact(id);
      } catch (error) {
        flash(error.message, true);
      }
    }),
  );
  document.getElementById("task-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api(`/api/admin/contacts/${id}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          title: f.get("title"),
          dueAt: f.get("dueAt") ? new Date(f.get("dueAt")).toISOString() : null,
        }),
      });
      flash("Follow-up task added.");
      contact(id);
    } catch (error) {
      flash(error.message, true);
    }
  });
  document.getElementById("note-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api(`/api/admin/contacts/${id}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: new FormData(e.target).get("body") }),
      });
      flash("Note added.");
      contact(id);
    } catch (error) {
      flash(error.message, true);
    }
  });
}
async function events() {
  const d = await api("/api/admin/events");
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">CALENDAR</p><h1>Events</h1></div><button id="new-event">Create event</button></div><section class="panel"><div class="event-table">${d.events.map((e) => `<button data-event='${esc(JSON.stringify(e))}'><span><strong>${esc(e.title)}</strong><small>${date(e.starts_at)} · ${esc(e.venue || "Venue TBD")}</small></span><span class="status">${esc(e.status)}</span><b>${e.guest_count} guests</b></button>`).join("") || '<p class="empty">No events yet. Create the first one.</p>'}</div></section>`;
  document
    .getElementById("new-event")
    .addEventListener("click", () => eventForm());
  document
    .querySelectorAll("[data-event]")
    .forEach((el) =>
      el.addEventListener("click", () =>
        eventForm(JSON.parse(el.dataset.event)),
      ),
    );
}
function eventForm(event = {}) {
  const local = (v) =>
    v
      ? new Date(
          new Date(v).getTime() - new Date(v).getTimezoneOffset() * 60000,
        )
          .toISOString()
          .slice(0, 16)
      : "";
  modal.querySelector("#modal-content").innerHTML =
    `<p class="eyebrow">EVENT MANAGEMENT</p><h1>${event.id ? "Edit event" : "Create event"}</h1><form id="event-form" class="event-form"><label>Title<input name="title" required maxlength="200" value="${esc(event.title || "")}"></label><label>Status<select name="status">${["draft", "published", "canceled", "completed", "archived"].map((s) => `<option ${s === event.status ? "selected" : ""}>${s}</option>`).join("")}</select></label><label>Starts<input name="startsAt" type="datetime-local" required value="${local(event.starts_at)}"></label><label>Ends<input name="endsAt" type="datetime-local" value="${local(event.ends_at)}"></label><label>Venue<input name="venue" value="${esc(event.venue || "")}"></label><label>Address<input name="address" value="${esc(event.address || "")}"></label><label>City<input name="city" value="${esc(event.city || "")}"></label><label>Capacity<input name="capacity" type="number" min="1" value="${esc(event.capacity || "")}"></label><label class="wide">Description<textarea name="description" rows="4">${esc(event.description || "")}</textarea></label><label class="check"><input name="waitlistEnabled" type="checkbox" ${event.waitlist_enabled !== false ? "checked" : ""}> Enable waitlist when full</label><button>${event.id ? "Save changes" : "Create event"}</button></form>${event.id ? `<h2>RSVPs</h2><p><a href="/api/admin/events/${event.id}/rsvps.csv">Download attendee CSV</a></p><div id="attendees">Loading attendees…</div>` : ""}`;
  modal.showModal();
  if (event.id)
    api(`/api/admin/events/${event.id}/rsvps`)
      .then(
        (d) =>
          (document.getElementById("attendees").innerHTML = d.rsvps.length
            ? d.rsvps
                .map(
                  (r) =>
                    `<button class="request-row" data-contact="${r.contact_id}"><span><strong>${esc(r.first_name)} ${esc(r.last_name)}</strong><small>${esc(r.email || r.phone)}</small></span><span class="status">${esc(r.status)}</span><b>${r.guest_count} guest${r.guest_count === 1 ? "" : "s"}</b></button>`,
                )
                .join("")
            : '<p class="empty">No RSVPs yet.</p>'),
      )
      .then(bindRows);
  document
    .getElementById("event-form")
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const body = Object.fromEntries(f);
      body.startsAt = new Date(body.startsAt).toISOString();
      body.endsAt = body.endsAt ? new Date(body.endsAt).toISOString() : null;
      body.capacity = body.capacity ? Number(body.capacity) : null;
      body.waitlistEnabled = f.has("waitlistEnabled");
      try {
        await api(
          event.id ? `/api/admin/events/${event.id}` : "/api/admin/events",
          { method: event.id ? "PATCH" : "POST", body: JSON.stringify(body) },
        );
        modal.close();
        flash(event.id ? "Event updated." : "Event created.");
        events();
      } catch (error) {
        flash(error.message, true);
      }
    });
}
let emailFolder = "all";
function emailRow(c) {
  const name = c.first_name
    ? `${c.first_name} ${c.last_name || ""}`
    : c.from_address || "Unknown sender";
  return `<button class="email-row ${c.unread ? "unread" : ""}" data-email-id="${c.id}"><span class="email-meta"><strong>${esc(name)}</strong><time>${date(c.last_message_at)}</time></span><b>${esc(c.subject)}</b><small>${esc((c.preview || "").slice(0, 140))}</small></button>`;
}
async function email() {
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">COMMUNICATIONS</p><h1>Campaign email</h1></div></div><div class="email-toolbar" id="email-toolbar">${[
    ["all", "Inbox"],
    ["unread", "Unread"],
    ["assigned", "Assigned to me"],
    ["archived", "Archived"],
    ["spam", "Spam"],
  ]
    .map(
      ([key, label]) =>
        `<button data-email-folder="${key}" class="${emailFolder === key ? "active" : ""}">${label}</button>`,
    )
    .join(
      "",
    )}<input id="email-search" placeholder="Search sender, subject, or message"></div><div class="email-layout"><section class="panel email-list" id="email-list">Loading email…</section><section class="panel email-thread" id="email-thread"><p class="empty">Choose a conversation to read and reply.</p></section></div>`;
  document.querySelectorAll("[data-email-folder]").forEach((button) =>
    button.addEventListener("click", () => {
      emailFolder = button.dataset.emailFolder;
      email();
    }),
  );
  let timer;
  document.getElementById("email-search").addEventListener("input", (event) => {
    clearTimeout(timer);
    timer = setTimeout(() => loadEmailList(event.target.value), 250);
  });
  await loadEmailList();
}
async function loadEmailList(query = "") {
  const data = await api(
    `/api/admin/email/conversations?folder=${encodeURIComponent(emailFolder)}&q=${encodeURIComponent(query)}`,
  );
  const list = document.getElementById("email-list");
  list.innerHTML = data.conversations.length
    ? data.conversations.map(emailRow).join("")
    : '<p class="empty" style="padding:18px">No email conversations in this view.</p>';
  list
    .querySelectorAll("[data-email-id]")
    .forEach((row) =>
      row.addEventListener("click", () => emailThread(row.dataset.emailId)),
    );
}
function fileAttachment(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 8 * 1024 * 1024)
      return reject(new Error(`${file.name} is larger than 8 MB.`));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () =>
      resolve({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        content: String(reader.result).split(",")[1] || "",
      });
    reader.readAsDataURL(file);
  });
}
async function emailThread(id) {
  const data = await api(`/api/admin/email/conversations/${id}`);
  const c = data.conversation;
  const thread = document.getElementById("email-thread");
  const options = data.users
    .map(
      (user) =>
        `<option value="${user.id}" ${Number(c.assigned_user_id) === Number(user.id) ? "selected" : ""}>${esc(user.username)}</option>`,
    )
    .join("");
  thread.innerHTML = `${data.enabled ? "" : '<div class="email-disabled"><strong>Resend is not configured.</strong> You can manage inbound test data, but live receiving and replies stay off until the API key, sender, and webhook secret are added.</div>'}<div class="email-thread-head"><div><p class="eyebrow">EMAIL THREAD</p><h2>${esc(c.subject)}</h2><small>${c.contact_id ? `Linked to ${esc(`${c.first_name || ""} ${c.last_name || ""}`.trim() || c.contact_email)}` : "Not linked to a CRM contact"}</small></div><span class="status">${esc(c.status)}</span></div><div class="email-actions"><select id="email-assignee"><option value="">Unassigned</option>${options}</select><button data-email-action="followup">${c.needs_follow_up ? "Mark handled" : "Needs follow-up"}</button><button data-email-action="unread">Mark unread</button><button data-email-action="archive">${c.status === "archived" ? "Move to inbox" : "Archive"}</button><button data-email-action="spam">${c.status === "spam" ? "Move to inbox" : "Spam"}</button>${c.contact_id ? "" : `<button data-email-action="contact">Create/link CRM contact</button>`}</div><div>${data.messages
    .filter((m) => m.direction !== "draft")
    .map(
      (m) =>
        `<article class="email-message ${esc(m.direction)}"><header><div><strong>${esc(m.direction === "inbound" ? m.from_address : "Campaign reply")}</strong><small>${esc(m.direction)} · ${esc(m.delivery_status)}</small></div><time>${date(m.created_at)}</time></header><div class="email-body">${esc(m.text_body || "[HTML-only message]")}</div>${m.attachments?.length ? `<div class="email-attachments">${m.attachments.map((a) => `<span>📎 ${esc(a.filename)}${a.size_bytes ? ` · ${Math.ceil(a.size_bytes / 1024)} KB` : ""}</span>`).join("")}</div>` : ""}${m.error_message ? `<p class="error">${esc(m.error_message)}</p>` : ""}</article>`,
    )
    .join(
      "",
    )}</div><form id="email-compose" class="email-compose"><label>Reply<textarea name="text" rows="6" maxlength="100000" required placeholder="Write a reply…" ${data.enabled ? "" : "disabled"}></textarea></label><label>Attachments (up to 5, 8 MB total)<input name="attachments" type="file" multiple ${data.enabled ? "" : "disabled"}></label><button ${data.enabled ? "" : "disabled"}>Send reply</button></form><section class="email-notes"><h2>Internal notes</h2><form id="email-note" class="email-note"><textarea name="body" rows="3" maxlength="5000" required placeholder="Private note, never sent to the contact"></textarea><button>Add note</button></form>${data.notes.map((note) => `<div class="email-note-item"><small>${esc(note.author_email || "Former user")} · ${date(note.created_at)}</small><p>${esc(note.body)}</p></div>`).join("") || '<p class="empty">No internal notes.</p>'}</section>`;
  document
    .getElementById("email-assignee")
    .addEventListener("change", (event) =>
      updateEmail(id, { assignedUserId: event.target.value || null }),
    );
  thread.querySelectorAll("[data-email-action]").forEach((button) =>
    button.addEventListener("click", async () => {
      const action = button.dataset.emailAction;
      if (action === "contact") {
        await api(`/api/admin/email/conversations/${id}/link-contact`, {
          method: "POST",
          body: "{}",
        });
        flash("CRM contact linked.");
        return emailThread(id);
      }
      if (action === "followup")
        return updateEmail(id, { needsFollowUp: !c.needs_follow_up });
      if (action === "unread") return updateEmail(id, { unread: true });
      if (action === "archive")
        return updateEmail(id, {
          status: c.status === "archived" ? "open" : "archived",
        });
      if (action === "spam")
        return updateEmail(id, {
          status: c.status === "spam" ? "open" : "spam",
        });
    }),
  );
  document
    .getElementById("email-compose")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.target.querySelector("button");
      button.disabled = true;
      button.textContent = "Sending…";
      try {
        const formData = new FormData(event.target);
        const files = [...event.target.elements.attachments.files];
        if (files.length > 5) throw new Error("Attach no more than 5 files.");
        const attachments = await Promise.all(files.map(fileAttachment));
        await api(`/api/admin/email/conversations//replies`, {
          method: "POST",
          body: JSON.stringify({ text: formData.get("text"), attachments }),
        });
        flash("Reply sent.");
        await emailThread(id);
        await refreshEmailBadge();
      } catch (error) {
        flash(error.message, true);
        button.disabled = false;
        button.textContent = "Send reply";
      }
    });
  document
    .getElementById("email-note")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      await api(`/api/admin/email/conversations/${id}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: new FormData(event.target).get("body") }),
      });
      flash("Internal note added.");
      emailThread(id);
    });
  await refreshEmailBadge();
}
async function updateEmail(id, changes) {
  try {
    await api(`/api/admin/email/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
    flash("Email updated.");
    if (changes.status && changes.status !== "open") {
      await email();
    } else {
      await emailThread(id);
      await loadEmailList();
    }
    await refreshEmailBadge();
  } catch (error) {
    flash(error.message, true);
  }
}
async function refreshEmailBadge() {
  try {
    const data = await api("/api/admin/email/conversations?folder=unread");
    const badge = document.getElementById("email-badge");
    badge.textContent = data.conversations.length;
    badge.hidden = !data.conversations.length;
  } catch {}
}
function analyticsTable(headers, rows) {
  return rows.length
    ? `<div class="analytics-table"><div class="analytics-tr head">${headers.map((h) => `<b>${esc(h)}</b>`).join("")}</div>${rows.join("")}</div>`
    : '<p class="empty">No data in this period.</p>';
}
function breakdown(rows) {
  const max = Math.max(1, ...rows.map((r) => Number(r.value)));
  return rows.length
    ? `<div class="breakdown">${rows.map((r) => `<div><span>${esc(r.label)}</span><i><em style="width:${Math.max(3, (Number(r.value) / max) * 100)}%"></em></i><b>${esc(r.value)}</b></div>`).join("")}</div>`
    : '<p class="empty">No data yet.</p>';
}
function trendChart(rows) {
  const max = Math.max(1, ...rows.map((r) => Number(r.page_views)));
  const points = rows
    .map(
      (r, i) =>
        `${rows.length === 1 ? 0 : (i / (rows.length - 1)) * 100},${48 - (Number(r.page_views) / max) * 44}`,
    )
    .join(" ");
  return `<div class="trend-chart"><svg viewBox="0 0 100 52" preserveAspectRatio="none" role="img" aria-label="Page views over time"><polyline points="${points}" fill="none" stroke="#7a1fb8" stroke-width="2" vector-effect="non-scaling-stroke"/><polygon points="0,52 ${points} 100,52" fill="rgba(122,31,184,.10)"/></svg><div><span>${esc(rows[0]?.day || "")}</span><span>${esc(rows.at(-1)?.day || "")}</span></div></div>`;
}
async function analytics(days = 30) {
  view.innerHTML = "<p>Loading analytics…</p>";
  const d = await api(`/api/admin/analytics?days=${days}`);
  const s = d.summary;
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">AUDIENCE</p><h1>Website analytics</h1><p class="muted">First-party reporting. Staff previews, bots, and IP addresses are excluded.</p></div><select id="analytics-range">${[
    [7, "Last 7 days"],
    [30, "Last 30 days"],
    [90, "Last 90 days"],
    [365, "Last year"],
  ]
    .map(
      ([v, l]) =>
        `<option value="${v}" ${v === d.days ? "selected" : ""}>${l}</option>`,
    )
    .join(
      "",
    )}</select></div><div class="metrics analytics-metrics">${card("Visitors", s.visitors, "Unique people")}${card("Sessions", s.sessions, "Visits")}${card("Page views", s.page_views, "Pages loaded")}${card("Pages / session", s.pages_per_session, "Depth of visit")}${card("Bounce rate", `${s.bounce_rate}%`, "One-page sessions")}${card("Conversions", s.conversions, "Campaign actions")}</div><section class="panel analytics-wide"><div class="panel-heading"><h2>Traffic trend</h2><span>Page views by day</span></div>${trendChart(d.trend)}</section><div class="analytics-grid"><section class="panel"><h2>Traffic sources</h2>${analyticsTable(
    ["Source", "Medium", "Sessions"],
    d.sources.map(
      (r) =>
        `<div class="analytics-tr"><span>${esc(r.source)}</span><span>${esc(r.medium)}</span><b>${esc(r.sessions)}</b></div>`,
    ),
  )}</section><section class="panel"><h2>Top pages</h2>${analyticsTable(
    ["Page", "Views", "Visitors"],
    d.pages.map(
      (r) =>
        `<div class="analytics-tr"><span title="${esc(r.page_path)}">${esc(r.page_path)}</span><b>${esc(r.views)}</b><span>${esc(r.visitors)}</span></div>`,
    ),
  )}</section><section class="panel"><h2>Campaigns</h2>${analyticsTable(
    ["Campaign", "Source", "Actions"],
    d.campaigns.map(
      (r) =>
        `<div class="analytics-tr"><span>${esc(r.campaign)}</span><span>${esc(r.source)}</span><b>${esc(r.conversions)}</b></div>`,
    ),
  )}</section><section class="panel"><h2>Conversions</h2>${analyticsTable(
    ["Action", "Count"],
    d.conversions.map(
      (r) =>
        `<div class="analytics-tr two"><span>${esc(r.event_name.replaceAll("_", " "))}</span><b>${esc(r.count)}</b></div>`,
    ),
  )}</section><section class="panel"><h2>Devices</h2>${breakdown(d.devices)}</section><section class="panel"><h2>Browsers</h2>${breakdown(d.browsers)}</section><section class="panel"><h2>Countries</h2>${breakdown(d.countries)}</section></div>`;
  document
    .getElementById("analytics-range")
    .addEventListener("change", (e) => analytics(Number(e.target.value)));
}
function roleDescription(role) {
  return (
    {
      admin: "Full access, including users and roles.",
      manager: "All campaign operations except user management.",
      staff: "Dashboard, CRM, email, and events.",
      viewer: "Read-only dashboard, analytics, CRM, email, and events.",
    }[role] || ""
  );
}
async function users() {
  const d = await api("/api/admin/users");
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">ACCESS CONTROL</p><h1>Admin users</h1><p class="muted">Create staff logins and control what each person can access.</p></div><button id="new-user">Add user</button></div><section class="panel"><div class="user-table">${d.users.map((u) => `<article><div><strong>${esc(u.username)}</strong><small>${esc(roleDescription(u.role))}</small></div><select data-user-role="${u.id}">${d.roles.map((r) => `<option value="${r}" ${r === u.role ? "selected" : ""}>${r}</option>`).join("")}</select><span class="status">${u.active ? "Active" : "Disabled"}</span><button data-user-toggle="${u.id}" data-active="${u.active}">${u.active ? "Disable" : "Enable"}</button><button data-user-password="${u.id}">Reset password</button></article>`).join("")}</div></section>`;
  document.getElementById("new-user").addEventListener("click", userForm);
  document.querySelectorAll("[data-user-role]").forEach((el) =>
    el.addEventListener("change", async () => {
      try {
        await api(`/api/admin/users/${el.dataset.userRole}`, {
          method: "PATCH",
          body: JSON.stringify({ role: el.value }),
        });
        flash("Role updated.");
        users();
      } catch (error) {
        flash(error.message, true);
        users();
      }
    }),
  );
  document.querySelectorAll("[data-user-toggle]").forEach((el) =>
    el.addEventListener("click", async () => {
      try {
        await api(`/api/admin/users/${el.dataset.userToggle}`, {
          method: "PATCH",
          body: JSON.stringify({ active: el.dataset.active !== "true" }),
        });
        flash("User access updated.");
        users();
      } catch (error) {
        flash(error.message, true);
      }
    }),
  );
  document
    .querySelectorAll("[data-user-password]")
    .forEach((el) =>
      el.addEventListener("click", () => passwordForm(el.dataset.userPassword)),
    );
}
function userForm() {
  modal.querySelector("#modal-content").innerHTML =
    `<p class="eyebrow">ACCESS CONTROL</p><h1>Add admin user</h1><form id="user-form" class="event-form"><label class="wide">Username<input name="username" type="text" minlength="2" maxlength="50" pattern="[A-Za-z][A-Za-z0-9._-]{1,49}" required></label><label>Role<select name="role">${["staff", "manager", "viewer", "admin"].map((r) => `<option value="${r}">${r}</option>`).join("")}</select></label><label>Temporary password<input name="password" type="password" minlength="8" pattern="(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{8,}" required autocomplete="new-password"></label><p class="muted wide">Use at least 8 characters, including one uppercase letter and one special character. Send the credentials privately.</p><button>Create login</button></form>`;
  modal.showModal();
  document.getElementById("user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      await api("/api/admin/users", {
        method: "POST",
        body: JSON.stringify(body),
      });
      modal.close();
      flash("User created.");
      users();
    } catch (error) {
      flash(error.message, true);
    }
  });
}
function passwordForm(id) {
  modal.querySelector("#modal-content").innerHTML =
    `<p class="eyebrow">ACCESS CONTROL</p><h1>Reset password</h1><form id="password-form"><label>New temporary password<input name="password" type="password" minlength="8" pattern="(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{8,}" required autocomplete="new-password"></label><p class="muted">Use at least 8 characters, including one uppercase letter and one special character.</p><button style="margin-top:18px">Reset password</button></form>`;
  modal.showModal();
  document
    .getElementById("password-form")
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api(`/api/admin/users/${id}`, {
          method: "PATCH",
          body: JSON.stringify({
            password: new FormData(e.target).get("password"),
          }),
        });
        modal.close();
        flash("Password reset. Existing sessions were signed out.");
      } catch (error) {
        flash(error.message, true);
      }
    });
}
async function render() {
  document
    .querySelectorAll("[data-view]")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.view === state.view),
    );
  try {
    await { dashboard, analytics, requests, email, events, users }[
      state.view
    ]();
  } catch (error) {
    view.innerHTML = `<div class="flash error">${esc(error.message)}</div>`;
  }
}
const analyticsNav = document.createElement("button");
analyticsNav.dataset.view = "analytics";
analyticsNav.dataset.permission = "analytics";
analyticsNav.textContent = "Analytics";
document.querySelector('[data-view="requests"]').before(analyticsNav);
document.querySelectorAll("[data-view]").forEach((b) =>
  b.addEventListener("click", () => {
    state.view = b.dataset.view;
    render();
  }),
);
document
  .querySelector(".modal-close")
  .addEventListener("click", () => modal.close());
api("/api/admin/session")
  .then((s) => {
    state.csrf = s.csrfToken;
    state.role = s.role;
    state.permissions = s.permissions || [];
    const allowed = (p) =>
      state.permissions.includes(p) || state.permissions.includes(`${p}:read`);
    document
      .querySelectorAll("[data-permission]")
      .forEach((el) => (el.hidden = !allowed(el.dataset.permission)));
    const viewPermissions = {
      analytics: "analytics",
      requests: "crm",
      email: "email",
      events: "events",
      users: "users",
    };
    document.querySelectorAll("[data-view]").forEach((el) => {
      const permission = viewPermissions[el.dataset.view];
      if (permission) el.hidden = !allowed(permission);
    });
    document.getElementById("csrf").value = s.csrfToken;
    document.getElementById("admin-email").textContent =
      `${s.username} · ${s.role}`;
    refreshEmailBadge();
    render();
  })
  .catch(() => location.assign("/admin/login"));
