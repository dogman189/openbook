// OpenBook renderer — single classic script (no ES modules: the packaged app
// loads over file:// where module CORS fails). Merges DOM helpers, /api/*
// wrappers, study panels, and boot/health/log wiring for the monet shell.
window.OB = window.OB || {};

(function (OB) {
  "use strict";

  var BASE = (window.APP_CONFIG && window.APP_CONFIG.backendUrl) || "http://127.0.0.1:5678";
  var THEME_KEY = "openbook-theme";

  // ---- DOM helpers -------------------------------------------------------
  // Everything user- or model-supplied goes through textContent, never
  // innerHTML, so document text and model output can't inject markup.
  function el(tag, opts) {
    opts = opts || {};
    var node = document.createElement(tag);
    if (opts.class) node.className = opts.class;
    if (opts.text != null) node.textContent = String(opts.text);
    if (opts.html) throw new Error("el(): html option is not allowed");
    if (opts.attrs) {
      Object.keys(opts.attrs).forEach(function (k) {
        var v = opts.attrs[k];
        if (v != null && v !== false) node.setAttribute(k, v === true ? "" : String(v));
      });
    }
    if (opts.on) {
      Object.keys(opts.on).forEach(function (evt) {
        node.addEventListener(evt, opts.on[evt]);
      });
    }
    (opts.children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function mount(slotId, nodes) {
    var slot = document.getElementById(slotId);
    if (!slot) return null;
    clear(slot);
    (nodes || []).filter(Boolean).forEach(function (n) {
      slot.appendChild(Array.isArray(n) ? frag(n) : n);
    });
    return slot;
  }

  function frag(nodes) {
    var f = document.createDocumentFragment();
    nodes.filter(Boolean).forEach(function (n) {
      f.appendChild(n);
    });
    return f;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  // ---- API (every path prefixed /api) ------------------------------------
  function url(path) {
    return BASE + path;
  }

  function jsonOrThrow(res, fallback) {
    if (!res.ok) {
      return res.text().then(function (t) {
        throw new Error(t || fallback + " failed: " + res.status);
      });
    }
    return res.json();
  }

  var api = {
    health: function () {
      return fetch(url("/api/health")).then(function (r) {
        return r.json();
      });
    },
    getConfig: function () {
      return fetch(url("/api/config")).then(function (r) {
        return jsonOrThrow(r, "Config");
      });
    },
    listNotebooks: function () {
      return fetch(url("/api/notebooks")).then(function (r) {
        return jsonOrThrow(r, "List");
      });
    },
    createNotebook: function (title) {
      return fetch(url("/api/notebooks"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title }),
      }).then(function (r) {
        return jsonOrThrow(r, "Create");
      });
    },
    deleteNotebook: function (nid) {
      return fetch(url("/api/notebooks/" + encodeURIComponent(nid)), {
        method: "DELETE",
      }).then(function (r) {
        return jsonOrThrow(r, "Delete");
      });
    },
    listSources: function (nid) {
      return fetch(url("/api/notebooks/" + encodeURIComponent(nid) + "/sources")).then(function (r) {
        return jsonOrThrow(r, "List sources");
      });
    },
    uploadFile: function (nid, file, signal) {
      var form = new FormData();
      form.append("file", file, file.name);
      return fetch(url("/api/notebooks/" + encodeURIComponent(nid) + "/sources"), {
        method: "POST",
        body: form,
        signal: signal,
      });
    },
    addText: function (nid, title, text) {
      return fetch(url("/api/notebooks/" + encodeURIComponent(nid) + "/sources"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text, title: title }),
      }).then(function (r) {
        return jsonOrThrow(r, "Upload");
      });
    },
    listMessages: function (nid) {
      return fetch(url("/api/notebooks/" + encodeURIComponent(nid) + "/messages")).then(function (r) {
        return jsonOrThrow(r, "History");
      });
    },
    summarize: function (nid, sourceIds) {
      return fetch(url("/api/notebooks/" + encodeURIComponent(nid) + "/summary"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceIds: sourceIds || [] }),
      }).then(function (r) {
        return jsonOrThrow(r, "Summary");
      });
    },
    listSummaries: function (nid) {
      return fetch(url("/api/notebooks/" + encodeURIComponent(nid) + "/summaries")).then(function (r) {
        return jsonOrThrow(r, "Summary");
      });
    },
    listModels: function () {
      return fetch(url("/api/models")).then(function (r) {
        return jsonOrThrow(r, "Models");
      });
    },
    switchModel: function (id) {
      return fetch(url("/api/models"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id }),
      }).then(function (r) {
        return jsonOrThrow(r, "Switch model");
      });
    },
    setEngine: function (body) {
      return fetch(url("/api/engine"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(function (r) {
        return jsonOrThrow(r, "Engine");
      });
    },
    chatStream: function (nid, query, signal) {
      return fetch(url("/api/notebooks/" + encodeURIComponent(nid) + "/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query }),
        signal: signal,
      });
    },
    postLog: function (message) {
      return fetch(url("/api/log"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message }),
      }).then(function (r) {
        return jsonOrThrow(r, "Log");
      });
    },
  };

  OB.el = el;
  OB.clear = clear;
  OB.mount = mount;
  OB.api = api;
  OB.BASE = BASE;
  OB.state = { nid: null, theme: "dark" };

  // Kept from the React port so the plan's test hook still resolves.
  OB.__test_hook = function () {
    return "chat";
  };

  // ---- Theme ---------------------------------------------------------------
  function applyTheme(theme) {
    var html = document.documentElement;
    if (theme === "light") html.classList.add("light");
    else html.classList.remove("light");
    OB.state.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      // storage unavailable — theme still applies for this session
    }
  }

  function initTheme() {
    var saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch (e) {
      saved = null;
    }
    applyTheme(saved === "light" ? "light" : "dark");
    var toggle = document.getElementById("theme-toggle");
    if (toggle) {
      toggle.addEventListener("click", function () {
        applyTheme(OB.state.theme === "dark" ? "light" : "dark");
        api.postLog("System: theme " + OB.state.theme).catch(function () {});
      });
    }
  }

  // ---- Health banner + status pill ------------------------------------------
  var healthPoll = null;

  function setStatus(ok) {
    var pill = document.getElementById("status-pill");
    var txt = document.getElementById("status-text");
    if (!pill || !txt) return;
    if (ok) {
      pill.classList.add("running");
      txt.textContent = "Ready";
    } else {
      pill.classList.remove("running");
      txt.textContent = "Loading";
    }
  }

  function renderHealth() {
    var slot = document.getElementById("banner-slot");
    if (!slot) return;

    function check() {
      api
        .health()
        .then(function (h) {
          if (h && h.backend === "ok") {
            clear(slot);
            setStatus(true);
          } else {
            setStatus(false);
            show();
          }
        })
        .catch(function () {
          setStatus(false);
          show();
        });
    }

    function show() {
      mount("banner-slot", [
        el("div", {
          class: "banner banner-warn",
          attrs: { role: "alert" },
          children: [
            el("div", { class: "banner-title", text: "Study engine is loading." }),
            el("div", {
              class: "banner-body",
              text:
                "Local models download on first run (~3-5GB: Qwen2.5-1.5B + MiniLM). " +
                "Wait a minute, then hit Retry. Your notes never leave this laptop.",
            }),
            el("button", {
              class: "btn btn-ghost btn-sm",
              text: "Retry",
              on: { click: check },
            }),
          ],
        }),
      ]);
    }

    check();
    // Poll so the banner clears itself once the backend finishes loading
    // models; the first model download can take a while.
    if (healthPoll) clearInterval(healthPoll);
    healthPoll = setInterval(function () {
      api
        .health()
        .then(function (h) {
          if (h && h.backend === "ok") {
            var s = document.getElementById("banner-slot");
            if (s) clear(s);
            setStatus(true);
            clearInterval(healthPoll);
            healthPoll = null;
          }
        })
        .catch(function () {
          // still starting
        });
    }, 5000);
  }

  // ---- Notebooks -------------------------------------------------------------
  function renderNotebooks() {
    var slot = document.getElementById("notebooks");
    if (!slot) return;
    clear(slot);
    slot.appendChild(el("h2", { class: "panel-title", text: "Notebooks" }));

    var errorBox = el("div", { class: "alert alert-error alert-mb" });
    errorBox.style.display = "none";
    slot.appendChild(errorBox);

    function showError(msg) {
      clear(errorBox);
      errorBox.style.display = "";
      errorBox.appendChild(document.createTextNode(msg + " "));
      errorBox.appendChild(
        el("button", { class: "btn btn-ghost btn-sm", text: "Retry", on: { click: load } })
      );
    }

    function newNotebookForm(placeholder) {
      var input = el("input", {
        class: "input",
        attrs: { "aria-label": "Notebook title", placeholder: placeholder },
      });
      var btn = el("button", {
        class: "btn btn-primary",
        text: "New notebook",
        on: { click: create },
      });
      function create() {
        var name = input.value.trim() || "Untitled notebook";
        api
          .createNotebook(name)
          .then(function (data) {
            return load().then(function () {
              if (data && data.id) selectNotebook(data.id);
            });
          })
          .catch(function (e) {
            showError(e.message || "Couldn't create notebook.");
          });
      }
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") create();
      });
      return el("div", {
        children: [input, el("div", { class: "row-mt", children: [btn] })],
      });
    }

    function emptyState() {
      slot.appendChild(el("h3", { class: "empty-title", text: "Create your first notebook" }));
      slot.appendChild(
        el("p", {
          class: "empty-body muted",
          text: "For Bio 101, Chem midterm, any class. Then drop in 2 PDFs to start asking.",
        })
      );
      slot.appendChild(newNotebookForm("e.g. Bio 101"));
    }

    function populated(list) {
      var ul = el("ul", { class: "nb-list" });
      list.forEach(function (n) {
        var active = n.id === OB.state.nid;
        var nameBtn = el("button", {
          class: active ? "nb-btn nb-btn-active" : "nb-btn",
          text: n.title,
          on: {
            click: function () {
              selectNotebook(n.id);
            },
          },
        });
        var del = el("button", {
          class: "btn btn-ghost btn-sm nb-del",
          text: "×",
          attrs: { "aria-label": "Delete " + n.title, title: "Delete " + n.title },
          on: {
            click: function () {
              if (
                !window.confirm(
                  'Delete "' + n.title + '" and all its sources, chats, and summaries?'
                )
              )
                return;
              api
                .deleteNotebook(n.id)
                .then(function () {
                  if (n.id === OB.state.nid) selectNotebook(null);
                  return load();
                })
                .catch(function (e) {
                  showError(e.message || "Couldn't delete notebook.");
                });
            },
          },
        });
        ul.appendChild(el("li", { class: "nb-item", children: [nameBtn, del] }));
      });
      slot.appendChild(ul);
      slot.appendChild(newNotebookForm("New notebook title"));
    }

    function load() {
      return api
        .listNotebooks()
        .then(function (data) {
          var list = Array.isArray(data) ? data : [];
          clear(slot);
          slot.appendChild(el("h2", { class: "panel-title", text: "Notebooks" }));
          if (list.length === 0) emptyState();
          else populated(list);
        })
        .catch(function (e) {
          clear(slot);
          slot.appendChild(el("h2", { class: "panel-title", text: "Notebooks" }));
          slot.appendChild(el("div", { class: "muted", text: "Loading notebooks…" }));
          slot.appendChild(errorBox);
          showError(e.message || "Couldn't load notebooks.");
        });
    }

    load();
    OB.refreshNotebooks = load;
  }

  // ---- Sources ---------------------------------------------------------------
  function friendlyUploadError(raw) {
    var lower = (raw || "").toLowerCase();
    if (lower.includes("100mb") || lower.includes("1000 pages") || lower.includes("too big")) {
      return "This file is too big for v1 (limit 100MB / 1000 pages). Try splitting it by chapters.";
    }
    if (
      lower.includes("scanned") ||
      lower.includes("ocr not in v1") ||
      lower.includes("extracted text too short") ||
      lower.includes("too short")
    ) {
      return "This looks like a scanned PDF with no selectable text. OpenBook v1 can't read scans yet — try an exported PDF or paste the text.";
    }
    if (lower.includes("corrupt") || lower.includes("damaged") || lower.includes("couldn't read")) {
      return "Couldn't read this PDF — file looks damaged. Try re-exporting it.";
    }
    return raw;
  }

  function renderSources(nid) {
    var slot = document.getElementById("sources-slot");
    if (!slot) return;
    if (!nid) {
      clear(slot);
      return;
    }
    var fileInput = null;
    var abortRef = null;
    var uploadingName = null;
    var lastAdded = null;
    var errorMsg = null;
    var showPaste = false;
    var pasteTitle = "";
    var pasteText = "";
    var sources = [];

    function loadSources() {
      return api
        .listSources(nid)
        .then(function (rows) {
          sources = Array.isArray(rows) ? rows : [];
          paint();
        })
        .catch(function () {
          // backend down — the upload attempt will surface the real error
        });
    }

    function uploadFiles(files) {
      if (!files || files.length === 0) return;
      var list = Array.prototype.slice.call(files);
      (function next(i) {
        if (i >= list.length) return;
        var file = list[i];
        var ctrl = new AbortController();
        abortRef = ctrl;
        uploadingName = file.name;
        paint();
        api
          .uploadFile(nid, file, ctrl.signal)
          .then(function (res) {
            if (!res.ok) {
              return res.text().then(function (t) {
                throw new Error(friendlyUploadError(t || "Upload failed: " + res.status));
              });
            }
            return res.json();
          })
          .then(function (data) {
            lastAdded =
              (data.sourceId || file.name) +
              " — " +
              (data.pages != null ? data.pages : "?") +
              " pages, " +
              (data.chunks != null ? data.chunks : "?") +
              " chunks";
            errorMsg = null;
            loadSources();
          })
          .catch(function (e) {
            if (e.name === "AbortError") return;
            errorMsg = e.message || "Couldn't add source.";
          })
          .then(function () {
            uploadingName = null;
            paint();
            next(i + 1);
          });
      })(0);
      if (fileInput) fileInput.value = "";
    }

    function addPastedText() {
      if (pasteText.trim().length === 0) {
        errorMsg = "Paste some lecture text first.";
        paint();
        return;
      }
      uploadingName = pasteTitle.trim() || "paste.txt";
      errorMsg = null;
      paint();
      api
        .addText(nid, pasteTitle.trim() || "paste.txt", pasteText)
        .then(function (data) {
          lastAdded = (data.sourceId || "paste.txt") + " added.";
          pasteText = "";
          pasteTitle = "";
          showPaste = false;
          return loadSources();
        })
        .catch(function (e) {
          errorMsg = e.message || "Couldn't add pasted text.";
        })
        .then(function () {
          uploadingName = null;
          paint();
        });
    }

    function buildCard() {
      fileInput = el("input", {
        class: "file-hidden",
        attrs: { type: "file", accept: ".pdf,.txt", multiple: true },
        on: {
          change: function (e) {
            uploadFiles(e.target.files);
          },
        },
      });

      var card = el("section", {
        class: "card",
        attrs: { "aria-label": "Sources" },
        children: [
          el("h2", { class: "panel-title", text: "Sources" }),
          el("h3", { class: "panel-subtitle", text: "Add your sources" }),
          el("p", {
            class: "panel-desc muted",
            text: "Drag PDFs here or paste lecture text. OpenBook only answers from what you add.",
          }),
          fileInput,
          el("div", {
            class: "row",
            children: [
              el("button", {
                class: "btn btn-primary",
                text: "Drop PDFs",
                on: {
                  click: function () {
                    if (fileInput) fileInput.click();
                  },
                },
              }),
              el("button", {
                class: "btn btn-ghost",
                text: "Paste text",
                on: {
                  click: function () {
                    showPaste = !showPaste;
                    paint();
                  },
                },
              }),
            ],
          }),
        ],
      });

      if (showPaste) {
        var titleInput = el("input", {
          class: "input",
          attrs: { "aria-label": "Pasted source title", placeholder: "Title e.g. lecture-3-notes" },
          on: {
            input: function (e) {
              pasteTitle = e.target.value;
            },
          },
        });
        titleInput.value = pasteTitle;
        var area = el("textarea", {
          class: "input",
          attrs: {
            "aria-label": "Pasted lecture text",
            placeholder: "Paste lecture text here…",
            rows: "4",
          },
          on: {
            input: function (e) {
              pasteText = e.target.value;
            },
          },
        });
        area.value = pasteText;
        card.appendChild(
          el("div", {
            class: "paste-box",
            children: [
              titleInput,
              el("div", { class: "row-mt", children: [area] }),
              el("div", {
                class: "row row-mt",
                children: [
                  el("button", {
                    class: "btn btn-primary",
                    text: "Add text",
                    on: { click: addPastedText },
                  }),
                  el("button", {
                    class: "btn btn-ghost",
                    text: "Close",
                    on: {
                      click: function () {
                        showPaste = false;
                        paint();
                      },
                    },
                  }),
                ],
              }),
            ],
          })
        );
      }

      if (uploadingName) {
        card.appendChild(
          el("div", {
            class: "progress",
            children: [
              document.createTextNode("Adding " + uploadingName + "… "),
              el("button", {
                class: "btn btn-ghost btn-sm",
                text: "Cancel",
                on: {
                  click: function () {
                    if (abortRef) abortRef.abort();
                    uploadingName = null;
                    paint();
                  },
                },
              }),
            ],
          })
        );
      }

      if (sources.length > 0) {
        var ul = el("ul", { class: "src-list" });
        sources.forEach(function (s) {
          ul.appendChild(el("li", { text: s.name + " — " + s.pages + " pages" }));
        });
        card.appendChild(ul);
      }

      if (lastAdded) {
        card.appendChild(el("div", { class: "success", text: lastAdded }));
      }
      return card;
    }

    function paint() {
      var err = errorMsg ? el("div", { class: "alert alert-error", text: errorMsg }) : null;
      mount("sources-slot", [buildCard(), err]);
    }

    paint();
    loadSources();
  }

  // ---- Chat (POST streams data: {"token"} until data: [DONE]) ------------------
  function citationNodes(text) {
    // [sourceName p.N] -> clickable chip; everything else becomes text nodes.
    var out = [];
    var re = /\[([^\]]+?)\s+p\.(\d+)\]/g;
    var last = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
      out.push(
        el("a", {
          class: "citation",
          text: "[" + m[1] + " p." + m[2] + "]",
          attrs: { href: "#", title: "Open source p." + m[2] },
          on: {
            click: function (e) {
              e.preventDefault();
            },
          },
        })
      );
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(document.createTextNode(text.slice(last)));
    return out;
  }

  function renderChat(nid) {
    var slot = document.getElementById("center-slot");
    if (!slot) return;
    clear(slot);
    if (!nid) {
      slot.appendChild(
        el("div", {
          class: "empty",
          children: [
            el("p", { text: "Select a notebook on the left, or create one to start asking." }),
          ],
        })
      );
      return;
    }

    var messages = [];
    var live = "";
    var streaming = false;
    var historyLoaded = false;
    var errorMsg = null;

    api
      .listMessages(nid)
      .then(function (data) {
        if (Array.isArray(data)) messages = data;
      })
      .catch(function (e) {
        errorMsg = e.message || "Couldn't load history.";
      })
      .then(function () {
        historyLoaded = true;
        paint();
      });

    function send() {
      var query = input.value.trim();
      if (!query || streaming) return;
      errorMsg = null;
      live = "";
      streaming = true;
      lockInputs(true);
      paint();

      var acc = "";
      api
        .chatStream(nid, query)
        .then(function (r) {
          if (!r.ok) throw new Error("Ask failed: " + r.status);
          return r.body.getReader();
        })
        .then(function (reader) {
          var dec = new TextDecoder();
          function pump() {
            return reader.read().then(function (chunk) {
              if (chunk.done) return null;
              var raw = dec.decode(chunk.value, { stream: true });
              raw.split("\n").forEach(function (line) {
                var t = line.trim();
                if (!t) return;
                if (!t.startsWith("data:")) {
                  if (t) {
                    acc += t;
                    live = acc;
                  }
                  return;
                }
                var payload = t.slice("data:".length).trim();
                if (payload === "[DONE]") return;
                try {
                  var obj = JSON.parse(payload);
                  if (typeof obj.token === "string") acc += obj.token;
                  else if (typeof obj === "string") acc += obj;
                } catch (e) {
                  // Partial JSON frame — append raw so no tokens are lost.
                  acc += payload;
                }
                live = acc;
              });
              paint();
              return pump();
            });
          }
          return pump();
        })
        .then(function () {
          var finalText = acc.trim() || "Not in your sources.";
          messages = messages.concat([
            { role: "user", content: query },
            { role: "assistant", content: finalText },
          ]);
          live = "";
          input.value = "";
        })
        .catch(function (e) {
          if (e.name !== "AbortError") errorMsg = e.message || "Ask failed. Try again.";
        })
        .then(function () {
          streaming = false;
          lockInputs(false);
          paint();
        });
    }

    var input = el("input", {
      class: "input chat-input",
      attrs: {
        "aria-label": "Ask your sources",
        placeholder: 'Ask anything from your sources — e.g. "Explain mitosis checkpoints simply?"',
      },
      on: {
        keydown: function (e) {
          if (e.key === "Enter") send();
        },
      },
    });

    function lockInputs(v) {
      input.disabled = v;
      var btn = slot.querySelector(".chat-send");
      if (btn) btn.disabled = v;
    }

    function bubble(m) {
      var isUser = m.role === "user";
      var body = el("span", {});
      clear(body);
      if (isUser) body.textContent = m.content;
      else {
        citationNodes(m.content || "").forEach(function (n) {
          body.appendChild(n);
        });
      }

      var kids = [el("strong", { text: isUser ? "You: " : "OpenBook: " }), body];
      if (!isUser && (m.content || "").startsWith("Not in your sources")) {
        kids.push(
          el("div", {
            class: "hint muted",
            text: "Not in your sources — try rephrasing, or add another lecture file.",
          })
        );
      }
      return el("div", {
        class: isUser ? "msg msg-user" : "msg msg-assistant",
        children: kids,
      });
    }

    function build() {
      var list = el("div", { class: "chat-list" });
      if (messages.length === 0 && !live) {
        list.appendChild(
          el("div", {
            class: "hint hint-mb muted",
            text: "Answers show [source p.X] — click to see where it came from.",
          })
        );
      }
      if (historyLoaded && messages.length > 0) {
        list.appendChild(
          el("div", { class: "history-note muted", text: "Picked up where you left off." })
        );
      }
      messages.forEach(function (m) {
        list.appendChild(bubble(m));
      });
      if (streaming || live) {
        var pre = el("pre", { class: "live-pre" });
        citationNodes(live).forEach(function (n) {
          pre.appendChild(n);
        });
        list.appendChild(
          el("div", {
            class: "streaming",
            children: [
              el("div", {
                class: "streaming-hint muted",
                text: "Finding it in your sources…",
              }),
              pre,
            ],
          })
        );
      }

      var askBtn = el("button", {
        class: "btn btn-primary chat-send",
        text: "Ask",
        attrs: streaming ? { disabled: true } : {},
        on: { click: send },
      });

      var kids = [
        el("h2", { class: "panel-title", text: "Ask" }),
        list,
        el("div", { class: "row chat-input-row", children: [input, askBtn] }),
        el("div", {
          class: "hint hint-mt muted",
          text: "Answers show [source p.X] — click to see where it came from.",
        }),
      ];
      if (errorMsg) {
        kids.push(el("div", { class: "alert alert-error", text: errorMsg }));
      }
      return el("section", { class: "card", attrs: { "aria-label": "Ask" }, children: kids });
    }

    function paint() {
      var scroll = slot.parentElement ? slot.parentElement.scrollTop : 0;
      mount("center-slot", [build()]);
      input = slot.querySelector(".chat-input") || input;
      if (slot.parentElement) slot.parentElement.scrollTop = scroll;
    }

    paint();
    input.addEventListener("input", function () {
      var btn = slot.querySelector(".chat-send");
      if (btn) btn.disabled = streaming || input.value.trim().length === 0;
    });
  }

  // ---- Studio (summary) ----------------------------------------------------------
  function renderSummary(nid) {
    var slot = document.getElementById("studio-slot");
    if (!slot) return;
    clear(slot);
    if (!nid) return;

    var result = null;
    var loading = false;
    var errorMsg = null;
    var copied = false;

    function generate() {
      loading = true;
      errorMsg = null;
      copied = false;
      paint();
      api
        .summarize(nid, [])
        .then(function (data) {
          result = {
            summary: String((data && data.summary) || ""),
            key_terms: Array.isArray(data && data.key_terms) ? data.key_terms.map(String) : [],
            outline: Array.isArray(data && data.outline) ? data.outline.map(String) : [],
          };
        })
        .catch(function (e) {
          errorMsg = e.message || "Couldn't generate summary.";
        })
        .then(function () {
          loading = false;
          paint();
        });
    }

    function copyGuide() {
      if (!result) return;
      var text =
        "Summary\n" +
        result.summary +
        "\n\nKey terms\n" +
        result.key_terms.join("\n") +
        "\n\nOutline\n" +
        result.outline.join("\n");
      if (!navigator.clipboard) {
        errorMsg = "Copy failed — select the text manually.";
        paint();
        return;
      }
      navigator.clipboard
        .writeText(text)
        .then(function () {
          copied = true;
          paint();
        })
        .catch(function () {
          errorMsg = "Copy failed — select the text manually.";
          paint();
        });
    }

    function build() {
      var kids = [el("h2", { class: "panel-title", text: "Summary" })];

      if (!result && !loading && !errorMsg) {
        kids.push(el("h3", { class: "empty-title", text: "Get the big picture" }));
        kids.push(
          el("p", {
            class: "empty-body muted",
            text: "Generate a summary with key terms + outline from your sources.",
          })
        );
        kids.push(
          el("button", { class: "btn btn-primary", text: "Generate summary", on: { click: generate } })
        );
      }
      if (loading) {
        kids.push(el("div", { text: "Reading all sources… this takes ~20s offline." }));
      }
      if (errorMsg) {
        kids.push(
          el("div", {
            class: "alert alert-error",
            children: [
              document.createTextNode(errorMsg + " "),
              el("button", { class: "btn btn-ghost btn-sm", text: "Retry", on: { click: generate } }),
            ],
          })
        );
      }
      if (result) {
        kids.push(el("h3", { text: "Summary" }));
        kids.push(el("p", { class: "summary-text", text: result.summary }));
        kids.push(el("h3", { text: "Key terms" }));
        var ul = el("ul", { class: "summary-list" });
        result.key_terms.forEach(function (k) {
          ul.appendChild(el("li", { text: k }));
        });
        kids.push(ul);
        kids.push(el("h3", { text: "Outline" }));
        var ol = el("ol", { class: "summary-list" });
        result.outline.forEach(function (o) {
          ol.appendChild(el("li", { text: o }));
        });
        kids.push(ol);
        kids.push(
          el("button", { class: "btn", text: "Copy study guide", on: { click: copyGuide } })
        );
        if (copied) {
          kids.push(el("span", { class: "success success-inline", text: "Copied!" }));
        }
        kids.push(
          el("div", {
            class: "row-mt",
            children: [
              el("button", {
                class: "btn",
                text: "Generate summary",
                attrs: loading ? { disabled: true } : {},
                on: { click: generate },
              }),
            ],
          })
        );
      }

      return el("section", { class: "card", attrs: { "aria-label": "Summary" }, children: kids });
    }

    function paint() {
      mount("studio-slot", [build()]);
    }

    paint();

    // Restore the last saved summary so it survives a restart.
    api
      .listSummaries(nid)
      .then(function (rows) {
        if (!Array.isArray(rows) || rows.length === 0) return;
        var data = JSON.parse(rows[0].content);
        result = {
          summary: String((data && data.summary) || ""),
          key_terms: Array.isArray(data && data.key_terms) ? data.key_terms.map(String) : [],
          outline: Array.isArray(data && data.outline) ? data.outline.map(String) : [],
        };
        paint();
      })
      .catch(function () {
        // no saved summary yet — empty state stays
      });
  }

  // ---- Model picker ---------------------------------------------------------------
  // ---- Engine (local vs OpenRouter cloud) --------------------------------------
  // Cloud is strictly opt-in: switching shows where notebook content goes.
  // The key is write-only — the backend never sends it back, so the input
  // only ever shows a placeholder, never a stored value.
  function renderEngine() {
    var slot = document.getElementById("engine-slot");
    if (!slot) return;

    var engine = "local";
    var model = "";
    var models = [];
    var keySet = false;
    var keyInput = "";
    var showKey = false;
    var busy = false;
    var errorMsg = null;
    var savedNote = "";

    function load() {
      return api
        .listModels()
        .then(function (data) {
          var eng = (data && data.engine) || {};
          engine = eng.engine === "openrouter" ? "openrouter" : "local";
          model = String(eng.openrouter_model || "");
          models = Array.isArray(eng.openrouter_models) ? eng.openrouter_models : [];
          keySet = !!eng.openrouter_key_set;
          errorMsg = null;
          paint();
        })
        .catch(function () {
          // backend down — HealthBanner owns that error
        });
    }

    function save(body, note) {
      busy = true;
      errorMsg = null;
      savedNote = "";
      paint();
      api
        .setEngine(body)
        .then(function () {
          keyInput = "";
          showKey = false;
          busy = false;
          savedNote = note || "Saved.";
          return load();
        })
        .catch(function (e) {
          errorMsg = (e && e.message) || "Couldn't save engine settings.";
          busy = false;
          paint();
        });
    }

    function paint() {
      var kids = [];
      kids.push(el("h3", { class: "panel-subtitle", text: "Engine" }));

      var toggle = el("div", {
        class: "row",
        children: [
          el("button", {
            class: "btn btn-sm" + (engine === "local" ? " btn-primary" : " btn-ghost"),
            text: "Local",
            attrs: busy ? { disabled: true } : {},
            on: {
              click: function () {
                if (engine !== "local") save({ engine: "local" }, "Local engine active — fully offline.");
              },
            },
          }),
          el("button", {
            class: "btn btn-sm" + (engine === "openrouter" ? " btn-primary" : " btn-ghost"),
            text: "OpenRouter",
            attrs: busy ? { disabled: true } : {},
            on: {
              click: function () {
                if (engine !== "openrouter") save({ engine: "openrouter" }, "Cloud engine active.");
              },
            },
          }),
        ],
      });
      kids.push(toggle);

      if (engine === "openrouter") {
        kids.push(
          el("p", {
            class: "hint hint-mt muted",
            text: "Cloud sends your notebook content to OpenRouter. Key stays on this laptop.",
          })
        );

        var sel = el("select", {
          class: "input model-select",
          attrs: { "aria-label": "OpenRouter model" },
          on: {
            change: function (e) {
              save({ openrouter_model: e.target.value }, "Model saved.");
            },
          },
        });
        if (busy) sel.setAttribute("disabled", "");
        var listed = models.some(function (m) {
          return m.id === model;
        });
        models.forEach(function (m) {
          sel.appendChild(el("option", { text: m.label, attrs: { value: m.id } }));
        });
        if (!listed && model) {
          sel.appendChild(el("option", { text: model + " (custom)", attrs: { value: model } }));
        }
        sel.value = model;
        kids.push(sel);

        var keyRow = el("div", {
          class: "model-custom",
          children: [
            el("span", {
              class: "hint muted",
              text: keySet ? "Key saved (hidden)." : "No key saved yet.",
            }),
          ],
        });
        if (showKey) {
          var saveBtn = el("button", {
            class: "btn btn-primary btn-sm",
            text: busy ? "Saving…" : "Save key",
            attrs: busy || !keyInput.trim() ? { disabled: true } : {},
            on: {
              click: function () {
                if (keyInput.trim()) save({ openrouter_key: keyInput.trim() }, "Key saved.");
              },
            },
          });
          var input = el("input", {
            class: "input",
            attrs: {
              type: "password",
              "aria-label": "OpenRouter API key",
              placeholder: "sk-or-…",
              autocomplete: "off",
            },
            on: {
              input: function (e) {
                // No repaint here (it would drop focus): flip the button directly.
                keyInput = e.target.value;
                if (keyInput.trim()) saveBtn.removeAttribute("disabled");
                else saveBtn.setAttribute("disabled", "");
              },
              keydown: function (e) {
                if (e.key === "Enter" && keyInput.trim()) {
                  save({ openrouter_key: keyInput.trim() }, "Key saved.");
                }
              },
            },
          });
          input.value = keyInput;
          keyRow.appendChild(input);
          keyRow.appendChild(
            el("div", {
              class: "model-custom-actions",
              children: [
                saveBtn,
                el("button", {
                  class: "btn btn-ghost btn-sm",
                  text: "Cancel",
                  on: {
                    click: function () {
                      showKey = false;
                      keyInput = "";
                      paint();
                    },
                  },
                }),
              ],
            })
          );
        } else {
          keyRow.appendChild(
            el("button", {
              class: "btn btn-ghost btn-sm",
              text: keySet ? "Replace key" : "Add key",
              attrs: busy ? { disabled: true } : {},
              on: {
                click: function () {
                  showKey = true;
                  paint();
                },
              },
            })
          );
          if (keySet) {
            keyRow.appendChild(
              el("button", {
                class: "btn btn-ghost btn-sm",
                text: "Clear",
                attrs: busy ? { disabled: true } : {},
                on: {
                  click: function () {
                    save({ openrouter_key: "" }, "Key cleared — cloud asks will fail until a new one is saved.");
                  },
                },
              })
            );
          }
        }
        kids.push(keyRow);
      }

      if (savedNote) {
        kids.push(el("span", { class: "success", text: savedNote }));
      }
      if (errorMsg) {
        kids.push(el("div", { class: "alert alert-error alert-mb", text: errorMsg }));
      }

      mount("engine-slot", [kids]);
    }

    load();
    OB.reloadEngine = load;
  }

  function renderModelPicker() {
    var slot = document.getElementById("model-picker");
    if (!slot) return;

    var current = "";
    var presets = [];
    var recommended = "";
    var showCustom = false;
    var custom = "";
    var busy = false;
    var errorMsg = null;

    function load() {
      return api
        .listModels()
        .then(function (data) {
          current = String((data && data.current) || "");
          presets = Array.isArray(data && data.available) ? data.available : [];
          if (data && data.recommended) recommended = String(data.recommended);
          errorMsg = null;
          paint();
        })
        .catch(function () {
          // backend down — HealthBanner owns that error
        });
    }

    function switchTo(id) {
      var mid = (id || "").trim();
      if (!mid || mid === current) return;
      busy = true;
      errorMsg = null;
      paint();
      api
        .switchModel(mid)
        .then(function (data) {
          current = String((data && data.llm) || mid);
          showCustom = false;
          custom = "";
          busy = false;
          return load();
        })
        .catch(function (e) {
          errorMsg = e.message || "Couldn't switch model.";
          busy = false;
          paint();
        });
    }

    function paint() {
      var inPresets = presets.some(function (p) {
        return p.id === current;
      });
      var currentPreset = presets.filter(function (p) {
        return p.id === current;
      })[0];

      var kids = [];

      var sel = el("select", {
        class: "input model-select",
        attrs: { "aria-label": "Study model" },
        on: {
          change: function (e) {
            if (e.target.value === "custom") {
              showCustom = true;
              paint();
            } else switchTo(e.target.value);
          },
        },
      });
      if (busy) sel.setAttribute("disabled", "");
      presets.forEach(function (p) {
        var label = p.label + " (" + p.vram + ")" + (p.id === recommended ? " ★" : "");
        if (p.fits === false) label += " — too big for this GPU";
        var opt = el("option", { text: label, attrs: { value: p.id } });
        if (p.fits === false) opt.setAttribute("disabled", "");
        sel.appendChild(opt);
      });
      sel.appendChild(el("option", { text: "Custom HF id…", attrs: { value: "custom" } }));
      if (inPresets) sel.value = current;
      else sel.value = "custom";
      kids.push(sel);

      if (!inPresets && current) {
        kids.push(el("span", { class: "muted model-current", text: current }));
      }
      if (currentPreset && currentPreset.fits === false) {
        kids.push(
          el("div", {
            class: "alert alert-error alert-mb",
            text: currentPreset.reason + " — pick a smaller model above.",
          })
        );
      }

      if (showCustom) {
        var input = el("input", {
          class: "input",
          attrs: { "aria-label": "Custom model id", placeholder: "org/model-name" },
          on: {
            input: function (e) {
              custom = e.target.value;
            },
            keydown: function (e) {
              if (e.key === "Enter") switchTo(custom);
            },
          },
        });
        input.value = custom;
        kids.push(
          el("div", {
            class: "model-custom",
            children: [
              input,
              el("div", {
                class: "model-custom-actions",
                children: [
                  el("button", {
                    class: "btn btn-primary btn-sm",
                    text: busy ? "Switching…" : "Switch model",
                    attrs: busy ? { disabled: true } : {},
                    on: {
                      click: function () {
                        switchTo(custom);
                      },
                    },
                  }),
                  el("button", {
                    class: "btn btn-ghost btn-sm",
                    text: "Cancel",
                    on: {
                      click: function () {
                        showCustom = false;
                        paint();
                      },
                    },
                  }),
                ],
              }),
            ],
          })
        );
      } else if (busy) {
        kids.push(el("span", { class: "muted", text: "Switching…" }));
      }

      if (errorMsg) {
        kids.push(el("div", { class: "alert alert-error alert-mb", text: errorMsg }));
      }

      mount("model-picker", [kids]);
      // Re-apply select state after mount so it reflects current/showCustom.
      var check = document.querySelector("#model-picker select");
      if (check) check.value = inPresets && !showCustom ? current : "custom";
    }

    paint();
    OB.reloadModelPicker = load;
  }

  // ---- Activity log (EventSource /api/logs) ----------------------------------------
  var logCount = 0;
  var evtSource = null;

  function startLogStream() {
    var out = document.getElementById("log-output");
    if (!out) return;
    if (evtSource) evtSource.close();
    evtSource = new EventSource(url("/api/logs"));
    evtSource.onmessage = function (e) {
      try {
        appendLog(JSON.parse(e.data));
      } catch (_) {
        appendLog(e.data);
      }
    };
  }

  function appendLog(line) {
    var out = document.getElementById("log-output");
    var badge = document.getElementById("log-count");
    if (!out) return;
    logCount++;
    if (badge) badge.textContent = logCount + " event" + (logCount !== 1 ? "s" : "");

    var time = "";
    var msg = "";
    if (line && typeof line === "object") {
      // Backend SSE payload: {"message", "ts" (unix seconds)}
      msg = String(line.message || "");
      if (typeof line.ts === "number") {
        var d = new Date(line.ts * 1000);
        var p2 = function (n) {
          return (n < 10 ? "0" : "") + n;
        };
        time = p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
      }
    } else {
      var m = String(line).match(/^\[(\d{2}:\d{2}:\d{2})\]\s+(.*)$/);
      time = m ? m[1] : "";
      msg = m ? m[2] : String(line);
    }

    var cls = "";
    if (/error/i.test(msg)) cls = "err";
    else if (/^system:/i.test(msg)) cls = "sys";

    var row = document.createElement("div");
    row.className = ("log-row " + cls).trim();
    var ts = document.createElement("span");
    ts.className = "log-ts";
    ts.textContent = time;
    var body = document.createElement("span");
    body.className = "log-body";
    body.textContent = msg;
    row.appendChild(ts);
    row.appendChild(body);
    out.appendChild(row);
    out.scrollTop = out.scrollHeight;

    while (out.children.length > 500) out.removeChild(out.firstChild);
  }

  // ---- Notebook selection ------------------------------------------------------------
  function selectNotebook(nid) {
    OB.state.nid = nid;
    api.postLog("System: opened notebook " + nid).catch(function () {});
    renderSources(nid);
    renderChat(nid);
    renderSummary(nid);
    if (OB.refreshNotebooks) OB.refreshNotebooks();
  }
  OB.selectNotebook = selectNotebook;
  OB.renderHealth = renderHealth;
  OB.renderNotebooks = renderNotebooks;
  OB.renderSources = renderSources;
  OB.renderChat = renderChat;
  OB.renderSummary = renderSummary;
  OB.renderModelPicker = renderModelPicker;
  OB.renderEngine = renderEngine;

  // ---- Boot -----------------------------------------------------------------------------
  function waitForBackend(retries, delay) {
    retries = retries == null ? 50 : retries;
    delay = delay == null ? 400 : delay;
    var i = 0;
    function attempt() {
      i++;
      return fetch(url("/api/config"))
        .then(function (r) {
          if (r.ok) return;
          throw new Error("not ready");
        })
        .catch(function () {
          if (i >= retries) return;
          return sleep(delay).then(attempt);
        });
    }
    return attempt();
  }

  function loadConfig() {
    return api
      .getConfig()
      .then(function (d) {
        if (d && (d.theme === "light" || d.theme === "dark")) {
          try {
            if (!localStorage.getItem(THEME_KEY)) applyTheme(d.theme);
          } catch (e) {
            applyTheme(d.theme);
          }
        }
      })
      .catch(function () {
        // backend serves {} by default — theme stays local
      });
  }

  function boot() {
    initTheme();
    renderHealth();
    renderNotebooks();
    renderModelPicker();
    renderEngine();
    renderChat(null);
    if (window.SETUP && window.SETUP.getStatus) {
      window.SETUP.getStatus()
        .then(function (st) {
          if (st && st.ok) normalReady();
          else renderSetup(st || {});
        })
        .catch(function () {
          normalReady();
        });
    } else {
      normalReady();
    }
  }

  function normalReady() {
    waitForBackend()
      .then(loadConfig)
      .then(function () {
        startLogStream();
        var b = document.getElementById("boot");
        if (b) b.classList.add("hidden");
      });
  }

  // ---- Setup mode (missing Python deps) --------------------------------------
  // The backend cannot serve this screen — it may not even import — so the
  // Electron main process installs deps over the SETUP IPC bridge instead.
  function renderSetup(st) {
    var bootEl = document.getElementById("boot");
    if (bootEl) bootEl.classList.add("hidden");
    var box = document.getElementById("setup");
    if (!box) return;
    box.classList.remove("hidden");
    var desc = document.getElementById("setup-desc");
    var missing = document.getElementById("setup-missing");
    var btn = document.getElementById("setup-install");
    var logpre = document.getElementById("setup-log");
    if (!st || !st.python) {
      if (desc)
        desc.textContent =
          "Python 3.11+ was not found. Install it from python.org (tick 'Add Python to PATH'), restart OpenBook, then install dependencies here.";
      if (btn) btn.style.display = "none";
      return;
    }
    if (missing) missing.textContent = "Missing: " + (st.missing || []).join(", ");
    if (window.SETUP && window.SETUP.onProgress) {
      window.SETUP.onProgress(function (line) {
        if (!logpre) return;
        logpre.textContent += line + "\n";
        logpre.scrollTop = logpre.scrollHeight;
      });
    }
    if (btn) {
      btn.addEventListener("click", function () {
        btn.setAttribute("disabled", "");
        btn.textContent = "Installing…";
        window.SETUP
          .installDeps()
          .then(function (res) {
            if (res && res.code === 0) {
              btn.textContent = "Starting engine…";
              return window.SETUP.startBackend().then(function (r) {
                if (r && r.ok) {
                  box.classList.add("hidden");
                  normalReady();
                } else {
                  btn.removeAttribute("disabled");
                  btn.textContent = "Retry install";
                  if (logpre)
                    logpre.textContent +=
                      "Backend failed to start: " + ((r && r.error) || "unknown") + "\n";
                }
              });
            }
            btn.removeAttribute("disabled");
            btn.textContent = "Retry install";
          })
          .catch(function (e) {
            btn.removeAttribute("disabled");
            btn.textContent = "Retry install";
            if (logpre)
              logpre.textContent += "Install failed: " + (e && e.message) + "\n";
          });
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window.OB);
