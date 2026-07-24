// Flow Gmail Add-on
// Deploy via Google Apps Script

var DIRACT_API_URL = 'https://txzzgtwrrokomiphairy.supabase.co/functions/v1/gmail-addon';
var DATE_CALC_API_URL = 'https://txzzgtwrrokomiphairy.supabase.co/functions/v1/date-calc';
var AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];

// Apps Script projects run on whatever timezone the script is configured
// with (often UTC or US, not the user's) — so `new Date()` alone can put
// "today" on the wrong calendar day for an Australian user (e.g. a task
// due today reading as "due tomorrow"). All day-boundary math below is
// anchored to this timezone instead of the script's ambient one.
var APP_TIMEZONE = 'Australia/Sydney';

// "Today" as a YYYY-MM-DD string in APP_TIMEZONE, regardless of the
// script's own execution timezone.
function todayDateStr() {
  return Utilities.formatDate(new Date(), APP_TIMEZONE, 'yyyy-MM-dd');
}

// Parses a YYYY-MM-DD string into a UTC-midnight Date, so subtracting two
// such dates gives a whole-number day difference unaffected by timezone —
// only todayDateStr() needs to know about APP_TIMEZONE.
function dateStrToUtcMidnight(dateStr) {
  var parts = String(dateStr).substring(0, 10).split('-');
  return new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
}

// Whole-day difference between a YYYY-MM-DD date and "today", both
// resolved in APP_TIMEZONE.
function daysFromToday(dateStr) {
  var today = dateStrToUtcMidnight(todayDateStr());
  var target = dateStrToUtcMidnight(dateStr);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

// ── Helpers ────────────────────────────────────────────────────────

// Convert large decimal string to hex (for Gmail message IDs)
function decimalToHex(decStr) {
  var hex = '';
  var num = decStr;
  // Long division to convert decimal string to hex
  while (num !== '0' && num !== '') {
    var remainder = 0;
    var result = '';
    for (var i = 0; i < num.length; i++) {
      var current = remainder * 10 + parseInt(num[i]);
      result += Math.floor(current / 16).toString();
      remainder = current % 16;
    }
    hex = remainder.toString(16) + hex;
    // Remove leading zeros from result
    num = result.replace(/^0+/, '') || '0';
    if (num === '0') break;
  }
  return hex || '0';
}

function getUserEmail() {
  var email = Session.getActiveUser().getEmail();
  if (email) return email;
  try {
    var res = UrlFetchApp.fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() === 200) {
      return JSON.parse(res.getContentText()).email || '';
    }
  } catch (e) {}
  return '';
}

function getToken() {
  return ScriptApp.getOAuthToken();
}

function apiGet(path, token) {
  try {
    var res = UrlFetchApp.fetch(DIRACT_API_URL + path, {
      headers: {
        'X-User-Email': getUserEmail(),
        'X-Gmail-Access-Token': token || getToken(),
      },
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    var text = res.getContentText();
    return { ok: code === 200, code: code, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, code: 0, data: { error: err.message } };
  }
}

function cacheKeyForPath(path) {
  return 'api_' + path.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 200);
}

// Cached GET — use for endpoints that rarely change (user-context, label-settings)
function cachedApiGet(path, token, ttlSeconds) {
  var cache = CacheService.getUserCache();
  var key = cacheKeyForPath(path);
  var hit = cache.get(key);
  if (hit) {
    try { return { ok: true, code: 200, data: JSON.parse(hit), fromCache: true }; } catch(e) {}
  }
  var res = apiGet(path, token);
  if (res.ok) {
    try { cache.put(key, JSON.stringify(res.data), ttlSeconds || 300); } catch(e) {}
  }
  return res;
}

// Drop a cached GET response — call after an action that makes it stale
// (e.g. switching company invalidates the cached /user-context, which
// otherwise keeps showing the old active company for up to its TTL).
function invalidateCachedApiGet(path) {
  try { CacheService.getUserCache().remove(cacheKeyForPath(path)); } catch (e) {}
}

// Call after any mutation (create/update/delete task, apply template)
function invalidateTaskCache(companyId) {
  var cache = CacheService.getUserCache();
  try {
    cache.remove('task_ctx_' + companyId);
    cache.remove('api__user_context');
    cache.remove('api__label_settings');
  } catch(e) {}
}



function apiPost(path, body, token) {
  try {
    var res = UrlFetchApp.fetch(DIRACT_API_URL + path, {
      method: 'POST',
      contentType: 'application/json',
      headers: {
        'X-User-Email': getUserEmail(),
        'X-Gmail-Access-Token': token || getToken(),
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    var text = res.getContentText();
    return { ok: code === 200, code: code, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, code: 0, data: { error: err.message } };
  }
}

// Resolves "X days from [date]" — calendar or AU business days (skips weekends
// + public holidays for a state). Returns a YYYY-MM-DD string, or null on failure.
function calculateDueDate(fromDateStr, days, dayType, state) {
  try {
    var res = UrlFetchApp.fetch(DATE_CALC_API_URL, {
      method: 'POST',
      contentType: 'application/json',
      payload: JSON.stringify({
        fromDate: fromDateStr,
        days: days,
        mode: dayType === 'business' ? 'business' : 'calendar',
        state: dayType === 'business' ? state : undefined,
      }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('[calculateDueDate] error: ' + res.getContentText());
      return null;
    }
    var data = JSON.parse(res.getContentText());
    return data.resultDate || null;
  } catch (err) {
    Logger.log('[calculateDueDate] exception: ' + err.message);
    return null;
  }
}

// Parses a CardService DatePicker form value (msSinceEpoch, various shapes
// depending on formInput vs formInputs) into a YYYY-MM-DD string, or null.
function parseDatePickerValue(e, fieldName) {
  var raw = e.formInput ? e.formInput[fieldName] : (e.formInputs ? e.formInputs[fieldName] : null);
  if (!raw) return null;
  var ms = null;
  try { ms = parseInt(raw['msSinceEpoch']); } catch (_e) {}
  if (!ms || isNaN(ms)) { try { ms = parseInt(raw.msSinceEpoch); } catch (_e) {} }
  if (!ms || isNaN(ms)) { try { ms = parseInt(raw[0]); } catch (_e) {} }
  // formInputs (plural) sometimes wraps the value object in an array, e.g.
  // [{msSinceEpoch: "..."}] instead of {msSinceEpoch: "..."} — none of the
  // fallbacks above unwrap that shape, so try it explicitly.
  if (!ms || isNaN(ms)) { try { ms = parseInt(raw[0]['msSinceEpoch']); } catch (_e) {} }
  if (!ms || isNaN(ms) || ms <= 86400000) return null;
  var d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Human-friendly relative label for an arbitrary date — "today",
// "tomorrow", "in 3 days", "Monday next week", "in 3 weeks" — instead of a
// raw date string. Mirrors lib/relativeDate.ts (kept in sync manually
// since Apps Script can't import from the Next.js app).
var RELATIVE_DATE_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function getRelativeDateLabel(dateStr) {
  if (!dateStr) return null;
  var diffDays = daysFromToday(dateStr);
  var target = dateStrToUtcMidnight(dateStr);

  if (diffDays < 0) {
    var n = Math.abs(diffDays);
    return n + (n !== 1 ? ' days' : ' day') + ' ago';
  }
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays <= 6) return 'in ' + diffDays + ' days';
  if (diffDays <= 13) return RELATIVE_DATE_WEEKDAYS[target.getUTCDay()] + ' next week';
  var weeks = Math.round(diffDays / 7);
  return 'in ' + weeks + (weeks !== 1 ? ' weeks' : ' week');
}

// "Due" label for a task's own due date — mirrors the inline logic in
// buildTaskCardById's task-row rendering ("⚠ overdue N days", "🟠 due
// today", etc), factored out so the Home card's All-tasks list can use the
// same wording without duplicating the dot/urgency thresholds.
function getRelativeDueLabel(dueDate, isCompleted) {
  if (!dueDate || isCompleted) return null;
  var diffDays = daysFromToday(dueDate);
  if (diffDays < 0) {
    var n = Math.abs(diffDays);
    return '🟠 overdue ' + n + (n !== 1 ? ' days' : ' day');
  }
  if (diffDays === 0) return '🟠 due today';
  if (diffDays === 1) return '🟠 due tomorrow';
  if (diffDays <= 3) return '🟠 due in ' + diffDays + ' days';
  if (diffDays <= 7) return '🔵 due in ' + diffDays + ' days';
  if (diffDays <= 14) return '🟢 due in ' + diffDays + ' days';
  var weeks = Math.floor(diffDays / 7);
  return '🟢 due in ' + weeks + (weeks !== 1 ? ' weeks' : ' week');
}

// Task status is derived, not manually set — mirrors lib/taskStatus.ts
// (duplicated since Apps Script can't import from the Next.js app).
function getTaskStatusLabel(isCompleted, awaitingFollowUp) {
  if (isCompleted) return 'Complete';
  if (awaitingFollowUp) return 'Follow Up';
  return 'Pending';
}

// Simplified task-row view — shows only task name, matter number, project
// name, and due date instead of every field. Persisted per-user so it
// sticks across sessions; applies to both the Home card's "All My Tasks"
// and a project's task list.
function isSimplifiedTaskView() {
  return PropertiesService.getUserProperties().getProperty('simplifiedTaskView') === 'true';
}
function setSimplifiedTaskView(value) {
  PropertiesService.getUserProperties().setProperty('simplifiedTaskView', value ? 'true' : 'false');
}

// Short due-date string for the simplified view — date only (no relative
// urgency wording/emoji), with the time appended if the task has one.
function formatSimpleDueDate(dueDate, dueTime) {
  if (!dueDate) return 'No due date';
  var dateStr = String(dueDate).substring(0, 10);
  var d = new Date(dateStr + 'T00:00:00');
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var out = 'Due ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  if (dueTime) out += ' ' + String(dueTime).substring(0, 5);
  return out;
}

// Gmail web URL for a message, given its hex message ID (the same format
// already threaded through the add-on as `messageId`/`cleanMessageId`). Only
// safe to use for the email currently open in the viewer's own mailbox —
// Gmail message IDs don't resolve across different users' mailboxes, so this
// must never be used with a stored/cross-user sourceMessageId.
function gmailMessageUrl(messageId) {
  return 'https://mail.google.com/mail/u/0/#all/' + messageId;
}

// Captures an email's subject + body text so it can be stored on a task and
// read by any viewer — message IDs don't resolve across mailboxes, but plain
// text does. Truncates the body since Gmail messages can be very long.
function escapeCardHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

var EMAIL_BODY_MAX_CHARS = 4000;
function fetchMessageContent(token, messageId) {
  if (!messageId) return null;
  try {
    GmailApp.setCurrentMessageAccessToken(token);
    var msg = GmailApp.getMessageById(messageId);
    if (!msg) return null;
    var body = msg.getPlainBody() || '';
    if (body.length > EMAIL_BODY_MAX_CHARS) {
      body = body.slice(0, EMAIL_BODY_MAX_CHARS) + '…';
    }
    return { subject: msg.getSubject() || '', body: body };
  } catch (err) {
    Logger.log('[fetchMessageContent] failed: ' + err);
    return null;
  }
}

function errorNotification(msg) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification()
      .setText(msg)
      .setType(CardService.NotificationType.ERROR))
    .build();
}

function successNotification(msg) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification()
      .setText(msg)
      .setType(CardService.NotificationType.INFO))
    .setStateChanged(true)
    .build();
}

function getUserContext(token) {
  var result = cachedApiGet('/user-context', token, 300);
  if (!result.ok) return null;
  return result.data;
}

// ── Web App sidebar ────────────────────────────────────────────────

function openFlowSidebar(e) {
  var webAppUrl = ScriptApp.getService().getUrl();
  if (!webAppUrl) {
    return CardService.newUniversalActionResponseBuilder()
      .displayAddOnCards([CardService.newCardBuilder()
        .setHeader(CardService.newCardHeader().setTitle('Diract').setSubtitle('Web app not deployed'))
        .addSection(CardService.newCardSection()
          .addWidget(CardService.newTextParagraph()
            .setText('Please deploy this script as a Web App first:\nDeploy → New deployment → Web App')))
        .build()])
      .build();
  }

  var labelCode = '';

  // Try to get label code from current message if one is open
  try {
    if (e && e.gmail && e.gmail.accessToken && e.gmail.messageId) {
      var accessToken = e.gmail.accessToken;
      GmailApp.setCurrentMessageAccessToken(accessToken);
      var msg = GmailApp.getMessageById(e.gmail.messageId);
      var labels = msg.getThread().getLabels();
      for (var i = 0; i < labels.length; i++) {
        var labelName = labels[i].getName();
        var match = labelName.match(/\[([A-Z0-9]{5})\]$/);
        if (match) { labelCode = match[1]; break; }
      }
    }
  } catch (err) {
    Logger.log('Label detection error: ' + err.message);
  }

  // Pass code as URL param — web app reads window.location.search
  var url = webAppUrl + (labelCode ? '?code=' + labelCode : '');
  Logger.log('[openFlowSidebar] opening: ' + url + ' code=' + labelCode);

  return CardService.newUniversalActionResponseBuilder()
    .setOpenLink(CardService.newOpenLink()
      .setUrl(url)
      .setOpenAs(CardService.OpenAs.OVERLAY)
      .setOnClose(CardService.OnClose.NOTHING))
    .build();
}

// ── Entry points ───────────────────────────────────────────────────

function onHomepage(e) {
  return buildMainCard(null, null);
}

function onGmailCompose(e) {
  return buildMainCard(null, null);
}

function onGmailMessage(e) {
  Logger.log('[onGmailMessage] Full event: ' + JSON.stringify(e));
  Logger.log('[onGmailMessage] gmail object: ' + JSON.stringify(e.gmail || null));
  Logger.log('[onGmailMessage] messageId: ' + (e.gmail ? e.gmail.messageId : 'NO GMAIL OBJ'));
  Logger.log('[onGmailMessage] accessToken present: ' + !!(e.gmail && e.gmail.accessToken));

  var messageId = e.gmail ? e.gmail.messageId : null;
  var accessToken = e.gmail ? e.gmail.accessToken : null;
  var token = accessToken || getToken();

  // Gmail API needs raw hex ID — strip "msg-f:" or "thread-f:...| msg-f:" prefix
  var cleanMessageId = messageId ? messageId.replace(/^msg-f:/, '').replace(/^.*\|msg-f:/, '') : null;
  // Gmail REST API needs hex ID — the add-on passes a decimal number
  if (cleanMessageId && /^\d+$/.test(cleanMessageId)) {
    cleanMessageId = decimalToHex(cleanMessageId);
  }
  Logger.log('[onGmailMessage] cleanMessageId (hex): ' + cleanMessageId);

  // Use ScriptApp token for API calls (has broader scopes than e.gmail.accessToken)
  var apiToken = ScriptApp.getOAuthToken();

  var ctx = getUserContext(apiToken);
  Logger.log('[onGmailMessage] ctx activeCompanyId: ' + (ctx ? ctx.activeCompanyId : 'null'));
  if (!ctx) return buildMainCard(cleanMessageId, apiToken);
  var activeCompanyId = ctx.activeCompanyId;

  // Use ScriptApp token to fetch message labels from Gmail REST API
  try {
    Logger.log('[onGmailMessage] Fetching message with ScriptApp token, id=' + cleanMessageId);
    var msgRes = UrlFetchApp.fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + cleanMessageId + '?format=minimal',
      { headers: { Authorization: 'Bearer ' + apiToken }, muteHttpExceptions: true }
    );
    Logger.log('[onGmailMessage] message fetch status: ' + msgRes.getResponseCode());
    var msgText = msgRes.getContentText();
    Logger.log('[onGmailMessage] message response: ' + msgText.substring(0, 500));

    if (msgRes.getResponseCode() === 200) {
      var msgData = JSON.parse(msgText);
      var labelIds = msgData.labelIds || [];
      Logger.log('[onGmailMessage] labelIds: ' + JSON.stringify(labelIds));

      // Fetch all user labels
      var labelsRes = UrlFetchApp.fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/labels',
        { headers: { Authorization: 'Bearer ' + apiToken }, muteHttpExceptions: true }
      );
      Logger.log('[onGmailMessage] labels fetch status: ' + labelsRes.getResponseCode());
      if (labelsRes.getResponseCode() === 200) {
        var allLabels = JSON.parse(labelsRes.getContentText()).labels || [];
        var codeMatch = null;

        for (var i = 0; i < labelIds.length; i++) {
          for (var j = 0; j < allLabels.length; j++) {
            if (allLabels[j].id === labelIds[i]) {
              Logger.log('[onGmailMessage] checking label: ' + allLabels[j].name);
              var match = allLabels[j].name.match(/\[([A-Z0-9]{4,6})\]$/);
              if (match) { codeMatch = match[1]; break; }
            }
          }
          if (codeMatch) break;
        }

        Logger.log('[onGmailMessage] codeMatch: ' + codeMatch);

        if (codeMatch) {
          var projectRes = apiGet('/project-by-label?code=' + codeMatch + '&companyId=' + activeCompanyId, apiToken);
          Logger.log('[onGmailMessage] project lookup ok=' + projectRes.ok + ' data=' + JSON.stringify(projectRes.data).substring(0, 200));
          if (projectRes.ok && projectRes.data.project) {
            var p = projectRes.data.project;
            return buildTaskCardById(p.id, p.name, codeMatch, activeCompanyId, apiToken, cleanMessageId);
          }
        }
      }
    } else if (msgRes.getResponseCode() === 404) {
      Logger.log('[onGmailMessage] Message not found — may need hex ID conversion');
    }
  } catch (err) {
    Logger.log('[onGmailMessage] ERROR: ' + err.message);
  }

  return buildMainCard(cleanMessageId, apiToken);
}

// ── Main card ──────────────────────────────────────────────────────

function buildMainCard(messageId, accessToken, allTasksOffset, unallocatedOffset) {
  allTasksOffset = allTasksOffset || 0;
  unallocatedOffset = unallocatedOffset || 0;
  var token = accessToken || getToken();

  var ctx = getUserContext(token);
  if (!ctx) {
    var testRes = apiGet('/user-context', token);
    return CardService.newCardBuilder()
      .setHeader(CardService.newCardHeader().setTitle('Diract').setSubtitle('Not connected'))
      .addSection(CardService.newCardSection()
        .addWidget(CardService.newTextParagraph()
          .setText('Could not connect to Flow.\n\nEmail: ' + (getUserEmail() || 'NOT FOUND') +
            '\nStatus: ' + testRes.code +
            '\nError: ' + (testRes.data.error || JSON.stringify(testRes.data)) +
            '\n\nMake sure your Gmail is connected in the Flow app.')))
      .build();
  }

  var companies = ctx.companies || [];
  var activeCompanyId = ctx.activeCompanyId;
  var activeCompanyName = ctx.activeCompanyName || 'Unknown company';
  var isAdmin = false;
  for (var ci = 0; ci < companies.length; ci++) {
    if (companies[ci].id === activeCompanyId && companies[ci].role === 'company_admin') {
      isAdmin = true; break;
    }
  }

  var labelRes = cachedApiGet('/label-settings?companyId=' + activeCompanyId, token, 60);
  var labelSettings = labelRes.ok ? labelRes.data : null;

  var existingProject = null;
  if (messageId) {
    var checkRes = apiGet('/check-message?messageId=' + messageId + '&companyId=' + activeCompanyId, token);
    if (checkRes.ok && checkRes.data.projectId) existingProject = checkRes.data;
  }

  var card = CardService.newCardBuilder()
    .setName('main')
    .setHeader(CardService.newCardHeader()
      .setTitle('Diract')
      .setSubtitle(activeCompanyName));

  // ── Company switcher ──────────────────────────────────────────
  if (companies.length > 1) {
    var companySelect = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('companyId')
      .setTitle('Active company');
    for (var ci2 = 0; ci2 < companies.length; ci2++) {
      var c = companies[ci2];
      companySelect.addItem(c.name + (c.role === 'company_admin' ? ' (Admin)' : ''), c.id, c.id === activeCompanyId);
    }
    card.addSection(CardService.newCardSection()
      .setHeader('Company')
      .addWidget(companySelect)
      .addWidget(CardService.newButtonSet()
        .addButton(CardService.newTextButton()
          .setText('Switch company')
          .setOnClickAction(CardService.newAction()
            .setFunctionName('onSwitchCompany')
            .setParameters({ token: token })))));
  } else {
    card.addSection(CardService.newCardSection()
      .addWidget(CardService.newDecoratedText()
        .setText(activeCompanyName)
        .setTopLabel('Company')
        .setBottomLabel(isAdmin ? 'Admin' : 'Member')));
  }

  // ── Currently assigned ────────────────────────────────────────
  if (existingProject) {
    var currentSection = CardService.newCardSection().setHeader('Currently assigned');
    currentSection.addWidget(CardService.newDecoratedText()
      .setText(existingProject.projectName)
      .setBottomLabel(existingProject.labelName || ''));

    currentSection.addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('📋 Access tasks for this project')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setBackgroundColor('#4f46e5')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onViewTasks')
          .setParameters({
            projectId: existingProject.projectId,
            projectName: existingProject.projectName,
            labelCode: existingProject.labelCode || '',
            companyId: activeCompanyId,
            messageId: messageId || '',
            accessToken: token,
          })))
      .addButton(isAdmin ? CardService.newTextButton()
        .setText('Remove')
        .setTextButtonStyle(CardService.TextButtonStyle.OUTLINED)
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onRemoveProject')
          .setParameters({
            messageId: messageId || '',
            accessToken: token,
            projectId: existingProject.projectId,
            projectName: existingProject.projectName,
          })) : CardService.newTextButton().setText('').setDisabled(true)));

    // Closed-matter archiving — always goes to an admin for approval,
    // regardless of who requests it (see /request-archive).
    currentSection.addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('🗄️ Request archive')
        .setTextButtonStyle(CardService.TextButtonStyle.OUTLINED)
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onRequestArchive')
          .setParameters({
            projectId: existingProject.projectId,
            projectName: existingProject.projectName,
            companyId: activeCompanyId,
            accessToken: token,
          }))));

    card.addSection(currentSection);
  }

  // ── Create project + label ────────────────────────────────────
  if (labelSettings) {
    var tokens = labelSettings.tokens || ['project_name'];
    var separator = labelSettings.separator || ' — ';
    var parentLabel = labelSettings.parentLabel || 'Shared Emails';
    var tokenLabels = { matter_number: 'matter', project_name: 'project name', year: 'year' };
    var previewParts = tokens.map(function(t) { return '[' + (tokenLabels[t] || t) + ']'; });
    var preview = parentLabel + '/' + previewParts.join(separator) + ' [CODE]';

    var createSection = CardService.newCardSection()
      .setHeader(existingProject ? 'Create another project' : 'Create project & label')
      .setCollapsible(!!existingProject)
      .addWidget(CardService.newTextParagraph().setText('Label format: ' + preview))
      .addWidget(CardService.newTextInput()
        .setFieldName('projectName').setTitle('Project name')
        );

    var hasMatter = false;
    for (var ti = 0; ti < tokens.length; ti++) {
      if (tokens[ti] === 'matter_number') { hasMatter = true; break; }
    }
    if (hasMatter) {
      createSection.addWidget(CardService.newTextInput()
        .setFieldName('matterNumber').setTitle('Matter number'));
    }

    createSection
      .addWidget(CardService.newSelectionInput()
        .setType(CardService.SelectionInputType.DROPDOWN)
        .setFieldName('status').setTitle('Status')
        .addItem('Active', 'active', true)
        .addItem('Open', 'Open', false)
        .addItem('In Progress', 'In Progress', false)
        .addItem('Completed', 'Completed', false)
        .addItem('Closed', 'Closed', false))
      .addWidget(CardService.newButtonSet()
        .addButton(CardService.newTextButton()
          .setText('Create project & label')
          .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
          .setBackgroundColor('#4f46e5')
          .setOnClickAction(CardService.newAction()
            .setFunctionName('onCreateProject')
            .setParameters({
              messageId: messageId || '',
              accessToken: token,
              companyId: activeCompanyId,
            }))));

    card.addSection(createSection);
  }

  // ── Browse projects to import ─────────────────────────────────
  card.addSection(CardService.newCardSection()
    .setHeader('Import labels from existing projects')
    .setCollapsible(true)
    .addWidget(CardService.newTextParagraph()
      .setText('Create Gmail labels for projects that already exist in Flow.'))
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('Browse projects to import')
        .setTextButtonStyle(CardService.TextButtonStyle.OUTLINED)
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onShowImportProjects')
          .setParameters({
            accessToken: token,
            companyId: activeCompanyId,
            statusFilter: '',
            query: '',
            page: '0',
          })))));

  // ── Import labels (filtered, background) ─────────────────────
  var jobRes = apiGet('/import-job-status?companyId=' + activeCompanyId, token);
  var runningJob = jobRes.ok ? jobRes.data.job : null;

  var importSection = CardService.newCardSection()
    .setHeader('Import labels')
    .setCollapsible(true);

  if (runningJob) {
    var pct = runningJob.total > 0 ? Math.round(runningJob.processed / runningJob.total * 100) : 0;
    var bar = '';
    for (var b = 0; b < 20; b++) { bar += b < Math.floor(pct / 5) ? '█' : '░'; }
    var statusLabel = runningJob.status === 'paused' ? '⏸ Paused — hit time limit' :
                      runningJob.status === 'failed' ? '❌ Failed' : '⏳ In progress...';
    importSection.addWidget(CardService.newTextParagraph()
      .setText(statusLabel + '\n' + bar + ' ' + pct + '%\n' +
        runningJob.processed + ' / ' + runningJob.total + ' projects\n' +
        '✓ ' + (runningJob.created || 0) + ' created · ' + (runningJob.existed || 0) + ' existed' +
        (runningJob.error ? '\n⚠ ' + runningJob.error : '')));

    var jobBtns = CardService.newButtonSet();
    jobBtns.addButton(CardService.newTextButton()
      .setText('↻ Refresh')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onHomepage')
        .setParameters({})));
    if (runningJob.status === 'paused' || runningJob.status === 'failed') {
      jobBtns.addButton(CardService.newTextButton()
        .setText('▶ Resume')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setBackgroundColor('#4f46e5')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onResumeImport')
          .setParameters({ accessToken: token, companyId: activeCompanyId, jobId: runningJob.id })));
    }
    jobBtns.addButton(CardService.newTextButton()
      .setText('✕ Cancel')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onCancelImport')
        .setParameters({ accessToken: token, companyId: activeCompanyId, jobId: runningJob.id })));
    importSection.addWidget(jobBtns);
  } else {
    importSection
      .addWidget(CardService.newTextParagraph()
        .setText('Filter projects and create labels in bulk. Runs in background.'))
      .addWidget(CardService.newButtonSet()
        .addButton(CardService.newTextButton()
          .setText('Browse & filter projects')
          .setTextButtonStyle(CardService.TextButtonStyle.OUTLINED)
          .setOnClickAction(CardService.newAction()
            .setFunctionName('onShowFilteredImport')
            .setParameters({ accessToken: token, companyId: activeCompanyId }))));
  }
  card.addSection(importSection);

  // ── Admin: manage labels ──────────────────────────────────────
  if (isAdmin) {
    card.addSection(CardService.newCardSection()
      .setHeader('Admin: manage labels')
      .setCollapsible(true)
      .addWidget(CardService.newButtonSet()
        .addButton(CardService.newTextButton()
          .setText('Manage / delete labels')
          .setTextButtonStyle(CardService.TextButtonStyle.OUTLINED)
          .setOnClickAction(CardService.newAction()
            .setFunctionName('onShowAllProjectsForDelete')
            .setParameters({
              accessToken: token,
              companyId: activeCompanyId,
              query: '',
            })))));
  }

  // ── All My Tasks ─────────────────────────────────────────────────
  // The requesting user's own active tasks across every project — every
  // field we track, with the Gmail label shown first so it's obvious which
  // label/thread a task lives under. Paginated 20 at a time.
  var allTasksPageSize = 20;
  var allTasksRes = ctx.userId
    ? cachedApiGet('/all-tasks?companyId=' + activeCompanyId + '&assigneeId=' + ctx.userId +
        '&limit=' + allTasksPageSize + '&offset=' + allTasksOffset, token, 30)
    : { ok: false };
  var allTasksData = allTasksRes.ok ? allTasksRes.data : null;

  var allTasksSimplified = isSimplifiedTaskView();
  var allTasksSection = CardService.newCardSection()
    .setHeader('All My Tasks')
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(0);

  allTasksSection.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText(allTasksSimplified ? '☰ Full view' : '☰ Simplify view')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onToggleTaskViewMode')
        .setParameters({ accessToken: token, messageId: messageId || '', offset: String(allTasksOffset), unallocatedOffset: String(unallocatedOffset) }))));

  if (allTasksData && allTasksData.tasks && allTasksData.tasks.length) {
    var atTasks = allTasksData.tasks;
    for (var ai = 0; ai < atTasks.length; ai++) {
      var at = atTasks[ai];

      var atLabel = at.labelName || 'No label';
      var atTitle = at.name;
      var atSub = '';

      if (allTasksSimplified) {
        atLabel = at.projectName || 'No project';
        if (at.matterNumber) atSub += at.matterNumber;
        atSub += (atSub ? ' · ' : '') + formatSimpleDueDate(at.dueDate, at.dueTime);
      } else {
        if (at.projectName) atSub += at.projectName;
        var atDaysLeft = getRelativeDueLabel(at.dueDate, at.isCompleted);
        if (atDaysLeft) atSub += (atSub ? ' · ' : '') + atDaysLeft;
        if (at.assignedTeam) atSub += (atSub ? ' · ' : '') + '👥 ' + at.assignedTeam;
        atSub += (atSub ? ' · ' : '') + getTaskStatusLabel(at.isCompleted, at.awaitingFollowUp);
        if (at.isMonetary && at.estimatedCost) atSub += (atSub ? ' · ' : '') + '$' + at.estimatedCost;
        if (at.createdBy) atSub += (atSub ? ' · ' : '') + 'Added by ' + at.createdBy;
        if (at.followUpCount) atSub += (atSub ? ' · ' : '') + '🚩 Followed up ' + at.followUpCount + 'x' + (at.followUpDate ? ' · last ' + getRelativeDateLabel(at.followUpDate) : '');
        if (at.scheduledFollowUpDate) atSub += (atSub ? ' · ' : '') + '📅 Follow-up scheduled ' + getRelativeDateLabel(at.scheduledFollowUpDate);
        if (at.notes) atSub += (atSub ? ' · ' : '') + '📝 ' + at.notes;
        if (at.sourceEmailSubject) atSub += (atSub ? ' · ' : '') + '📧 ' + at.sourceEmailSubject;
      }

      var atRow = CardService.newDecoratedText()
        .setTopLabel(atLabel)
        .setText(atTitle)
        .setWrapText(true)
        .setBottomLabel(atSub)
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onViewTasks')
          .setParameters({
            projectId: at.projectId || '',
            projectName: at.projectName || '',
            labelCode: at.labelCode || '',
            companyId: activeCompanyId,
            messageId: '',
            accessToken: token,
          }));

      allTasksSection.addWidget(atRow);
      // Spacing between rows — a divider reads clearer than blank widgets.
      if (ai < atTasks.length - 1) allTasksSection.addWidget(CardService.newDivider());
    }

    var atTotal = allTasksData.totalCount || atTasks.length;
    if (atTotal > allTasksPageSize) {
      var atFrom = allTasksOffset + 1;
      var atTo = allTasksOffset + atTasks.length;
      allTasksSection.addWidget(CardService.newTextParagraph()
        .setText('Showing ' + atFrom + '–' + atTo + ' of ' + atTotal));

      var atPageBtns = CardService.newButtonSet();
      if (allTasksOffset > 0) {
        atPageBtns.addButton(CardService.newTextButton()
          .setText('← Previous')
          .setOnClickAction(CardService.newAction()
            .setFunctionName('onChangeAllTasksPage')
            .setParameters({ accessToken: token, messageId: messageId || '', offset: String(Math.max(0, allTasksOffset - allTasksPageSize)), unallocatedOffset: String(unallocatedOffset) })));
      }
      if (atTo < atTotal) {
        atPageBtns.addButton(CardService.newTextButton()
          .setText('Next →')
          .setOnClickAction(CardService.newAction()
            .setFunctionName('onChangeAllTasksPage')
            .setParameters({ accessToken: token, messageId: messageId || '', offset: String(allTasksOffset + allTasksPageSize), unallocatedOffset: String(unallocatedOffset) })));
      }
      allTasksSection.addWidget(atPageBtns);
    }
  } else {
    allTasksSection.addWidget(CardService.newTextParagraph().setText('No active tasks.'));
  }

  card.addSection(allTasksSection);

  // ── Unallocated Tasks ─────────────────────────────────────────────
  // Company-wide tasks with no assignee — these fall through "All My
  // Tasks" and every other per-person view, so they need somewhere to
  // surface or they're effectively invisible. Paginated 20 at a time.
  var unallocatedPageSize = 20;
  var unallocatedRes = cachedApiGet('/unallocated-tasks?companyId=' + activeCompanyId +
      '&limit=' + unallocatedPageSize + '&offset=' + unallocatedOffset, token, 30);
  var unallocatedData = unallocatedRes.ok ? unallocatedRes.data : null;

  var unallocatedSection = CardService.newCardSection()
    .setHeader('Unallocated Tasks')
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(0);

  unallocatedSection.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText(allTasksSimplified ? '☰ Full view' : '☰ Simplify view')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onToggleTaskViewMode')
        .setParameters({ accessToken: token, messageId: messageId || '', offset: String(allTasksOffset), unallocatedOffset: String(unallocatedOffset) }))));

  if (unallocatedData && unallocatedData.tasks && unallocatedData.tasks.length) {
    var uTasks = unallocatedData.tasks;
    for (var ui = 0; ui < uTasks.length; ui++) {
      var ut = uTasks[ui];

      var uLabel = ut.labelName || 'No label';
      var uTitle = ut.name;
      var uSub = '';

      if (allTasksSimplified) {
        uLabel = ut.projectName || 'No project';
        if (ut.matterNumber) uSub += ut.matterNumber;
        uSub += (uSub ? ' · ' : '') + formatSimpleDueDate(ut.dueDate, ut.dueTime);
      } else {
        if (ut.projectName) uSub += ut.projectName;
        var uDaysLeft = getRelativeDueLabel(ut.dueDate, ut.isCompleted);
        if (uDaysLeft) uSub += (uSub ? ' · ' : '') + uDaysLeft;
        if (ut.assignedTeam) uSub += (uSub ? ' · ' : '') + '👥 ' + ut.assignedTeam;
        uSub += (uSub ? ' · ' : '') + getTaskStatusLabel(ut.isCompleted, ut.awaitingFollowUp);
        if (ut.isMonetary && ut.estimatedCost) uSub += (uSub ? ' · ' : '') + '$' + ut.estimatedCost;
        if (ut.createdBy) uSub += (uSub ? ' · ' : '') + 'Added by ' + ut.createdBy;
        if (ut.followUpCount) uSub += (uSub ? ' · ' : '') + '🚩 Followed up ' + ut.followUpCount + 'x' + (ut.followUpDate ? ' · last ' + getRelativeDateLabel(ut.followUpDate) : '');
        if (ut.scheduledFollowUpDate) uSub += (uSub ? ' · ' : '') + '📅 Follow-up scheduled ' + getRelativeDateLabel(ut.scheduledFollowUpDate);
        if (ut.notes) uSub += (uSub ? ' · ' : '') + '📝 ' + ut.notes;
        if (ut.sourceEmailSubject) uSub += (uSub ? ' · ' : '') + '📧 ' + ut.sourceEmailSubject;
      }

      var uRow = CardService.newDecoratedText()
        .setTopLabel(uLabel)
        .setText(uTitle)
        .setWrapText(true)
        .setBottomLabel(uSub)
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onViewTasks')
          .setParameters({
            projectId: ut.projectId || '',
            projectName: ut.projectName || '',
            labelCode: ut.labelCode || '',
            companyId: activeCompanyId,
            messageId: '',
            accessToken: token,
          }));

      unallocatedSection.addWidget(uRow);
      if (ui < uTasks.length - 1) unallocatedSection.addWidget(CardService.newDivider());
    }

    var uTotal = unallocatedData.totalCount || uTasks.length;
    if (uTotal > unallocatedPageSize) {
      var uFrom = unallocatedOffset + 1;
      var uTo = unallocatedOffset + uTasks.length;
      unallocatedSection.addWidget(CardService.newTextParagraph()
        .setText('Showing ' + uFrom + '–' + uTo + ' of ' + uTotal));

      var uPageBtns = CardService.newButtonSet();
      if (unallocatedOffset > 0) {
        uPageBtns.addButton(CardService.newTextButton()
          .setText('← Previous')
          .setOnClickAction(CardService.newAction()
            .setFunctionName('onChangeUnallocatedTasksPage')
            .setParameters({ accessToken: token, messageId: messageId || '', offset: String(allTasksOffset), unallocatedOffset: String(Math.max(0, unallocatedOffset - unallocatedPageSize)) })));
      }
      if (uTo < uTotal) {
        uPageBtns.addButton(CardService.newTextButton()
          .setText('Next →')
          .setOnClickAction(CardService.newAction()
            .setFunctionName('onChangeUnallocatedTasksPage')
            .setParameters({ accessToken: token, messageId: messageId || '', offset: String(allTasksOffset), unallocatedOffset: String(unallocatedOffset + unallocatedPageSize) })));
      }
      unallocatedSection.addWidget(uPageBtns);
    }
  } else {
    unallocatedSection.addWidget(CardService.newTextParagraph().setText('No unallocated tasks.'));
  }

  card.addSection(unallocatedSection);

  // ── View project tasks ────────────────────────────────────────
  card.addSection(CardService.newCardSection()
    .setHeader('Project tasks')
    .setCollapsible(true)
    .addWidget(CardService.newTextParagraph()
      .setText('Browse a labelled project to view and add tasks.'))
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('📋 Open tasks')
        .setTextButtonStyle(CardService.TextButtonStyle.OUTLINED)
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onShowProjectsForTasks')
          .setParameters({
            accessToken: token,
            companyId: activeCompanyId,
            query: '',
          })))));

  return card.build();
}

// Fired by the Home card's "All My Tasks" Previous/Next buttons.
function onChangeAllTasksPage(e) {
  var token = e.parameters.accessToken || getToken();
  var offset = parseInt(e.parameters.offset || '0') || 0;
  var unallocatedOffset = parseInt(e.parameters.unallocatedOffset || '0') || 0;
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .updateCard(buildMainCard(e.parameters.messageId || null, token, offset, unallocatedOffset)))
    .build();
}

// Fired by the Home card's "Unallocated Tasks" Previous/Next buttons.
function onChangeUnallocatedTasksPage(e) {
  var token = e.parameters.accessToken || getToken();
  var offset = parseInt(e.parameters.offset || '0') || 0;
  var unallocatedOffset = parseInt(e.parameters.unallocatedOffset || '0') || 0;
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .updateCard(buildMainCard(e.parameters.messageId || null, token, offset, unallocatedOffset)))
    .build();
}

// Flips the simplified/full view preference and re-renders the Home card.
function onToggleTaskViewMode(e) {
  var token = e.parameters.accessToken || getToken();
  setSimplifiedTaskView(!isSimplifiedTaskView());

  // Shared by the Home card's "All My Tasks" and a project's task list —
  // projectId is only present when toggled from the latter.
  if (e.parameters.projectId) {
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation()
        .updateCard(buildTaskCardById(
          e.parameters.projectId, e.parameters.projectName,
          e.parameters.labelCode, e.parameters.companyId,
          token, e.parameters.messageId || null)))
      .build();
  }

  var offset = parseInt(e.parameters.offset || '0') || 0;
  var unallocatedOffset = parseInt(e.parameters.unallocatedOffset || '0') || 0;
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .updateCard(buildMainCard(e.parameters.messageId || null, token, offset, unallocatedOffset)))
    .build();
}

// ── Switch company ─────────────────────────────────────────────────

function onSwitchCompany(e) {
  var companyId = ((e.formInputs.companyId || [])[0] || '').trim();
  var token = e.parameters.token || getToken();
  if (!companyId) return errorNotification('No company selected');
  var result = apiPost('/switch-company', { companyId: companyId }, token);
  if (!result.ok) return errorNotification('Failed to switch: ' + (result.data.error || 'Unknown'));
  invalidateCachedApiGet('/user-context');
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(buildMainCard(null, token)))
    .setNotification(CardService.newNotification()
      .setText('✓ Switched to ' + (result.data.companyName || companyId))
      .setType(CardService.NotificationType.INFO))
    .build();
}

// ── Task card ──────────────────────────────────────────────────────

function onViewTasks(e) {
  var token = e.parameters.accessToken || getToken();
  var projectId = e.parameters.projectId;
  var projectName = e.parameters.projectName || '';
  var labelCode = e.parameters.labelCode || '';
  var companyId = e.parameters.companyId;
  var messageId = e.parameters.messageId || null;
  var taskCard = buildTaskCardById(projectId, projectName, labelCode, companyId, token, messageId);
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(taskCard))
    .build();
}

function buildTaskCardById(projectId, projectName, labelCode, companyId, token, messageId, newTaskDraft) {
  Logger.log('[buildTaskCardById] START projectId=' + projectId);
  newTaskDraft = newTaskDraft || {};

  // ── Cache task-context (profiles/teams/statuses/templates) ───────
  // These change rarely — cache for 5 min per company
  var cache = CacheService.getUserCache();
  var cacheKey = 'task_ctx_' + companyId;
  var ctxData = null;
  var cached = cache.get(cacheKey);
  if (cached) {
    try { ctxData = JSON.parse(cached); Logger.log('[buildTaskCardById] ctx from cache'); } catch(e) {}
  }
  if (!ctxData) {
    var ctxRes = apiGet('/task-context?companyId=' + companyId, token);
    ctxData = ctxRes.ok ? ctxRes.data : {};
    try { cache.put(cacheKey, JSON.stringify(ctxData), 300); } catch(e) {} // 5 min TTL
    Logger.log('[buildTaskCardById] ctx fetched fresh');
  }
  var statuses = ctxData.statuses || [];
  var profiles = ctxData.profiles || [];
  var teams = ctxData.teams || [];
  var reminderOptions = ctxData.reminderOptions || [];
  var templates = ctxData.templates || [];

  // ── Fetch tasks (always fresh) ────────────────────────────────────
  var tasksRes = apiGet('/project-tasks?projectId=' + projectId, token);
  var tasks = tasksRes.ok ? (tasksRes.data.tasks || []) : [];
  var projectMatterNumber = tasksRes.ok ? (tasksRes.data.matterNumber || null) : null;
  var tasksSimplified = isSimplifiedTaskView();
  Logger.log('[buildTaskCardById] tasks=' + tasks.length + ' profiles=' + profiles.length + ' teams=' + teams.length);


  var card = CardService.newCardBuilder()
    .setName('tasks_' + projectId)
    .setHeader(CardService.newCardHeader()
      .setTitle(projectName)
      .setSubtitle(tasks.length + ' task(s) · Flow Task Manager'));

  // Closed-matter archiving — always goes to an admin for approval,
  // regardless of who requests it (see /request-archive).
  var archiveSection = CardService.newCardSection();
  archiveSection.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText('🗄️ Request archive')
      .setTextButtonStyle(CardService.TextButtonStyle.OUTLINED)
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onRequestArchive')
        .setParameters({
          projectId: projectId,
          projectName: projectName,
          companyId: companyId,
          accessToken: token,
        }))));
  card.addSection(archiveSection);

  var taskSection = CardService.newCardSection().setHeader('Tasks')
    .setCollapsible(true).setNumUncollapsibleWidgets(1);
  taskSection.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText(tasksSimplified ? '☰ Full view' : '☰ Simplify view')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onToggleTaskViewMode')
        .setParameters({
          accessToken: token, projectId: projectId, projectName: projectName,
          labelCode: labelCode, companyId: companyId, messageId: messageId || '',
        }))));
  if (!tasks.length) {
    taskSection.addWidget(CardService.newTextParagraph().setText('No tasks yet. Add one below.'));
  }

  for (var ti = 0; ti < tasks.length; ti++) {
    var t = tasks[ti];
    Logger.log('[task ' + ti + '] name=' + t.name + ' dueDate=' + t.dueDate + ' assignee=' + t.assignee + ' team=' + t.assignedTeam);
    var overdue = t.dueDate && !t.isCompleted && daysFromToday(t.dueDate) < 0;

    // Strikethrough completed tasks using Unicode combining strikethrough
    var taskName = t.name;
    if (t.isCompleted) {
      var struck = '';
      for (var ci = 0; ci < taskName.length; ci++) {
        struck += taskName[ci] + '̶';
      }
      taskName = struck;
    }

    var prefix = t.isCompleted ? '✓ ' : (overdue ? '⚠ ' : '○ ');
    var label = prefix + taskName;
    var sub = '';

    if (tasksSimplified) {
      // Task name, matter number, project name, due date — nothing else.
      if (projectMatterNumber) sub += projectMatterNumber;
      sub += (sub ? ' · ' : '') + (projectName || '');
      sub += (sub ? ' · ' : '') + formatSimpleDueDate(t.dueDate, t.dueTime);
    } else {
      // Time remaining indicator (same line as task name)
      if (t.dueDate && !t.isCompleted) {
        var diffDays = daysFromToday(t.dueDate);
        var timeStr = '';
        var dot = '';
        if (diffDays < 0) {
          // Overdue
          var overdueDays = Math.abs(diffDays);
          dot = '🟠';
          timeStr = overdueDays === 1 ? 'overdue 1 day' : 'overdue ' + overdueDays + ' days';
        } else if (diffDays === 0) {
          dot = '🟠';
          timeStr = 'due today';
        } else if (diffDays === 1) {
          dot = '🟠';
          timeStr = 'due tomorrow';
        } else if (diffDays <= 3) {
          dot = '🟠';
          timeStr = 'due in ' + diffDays + ' days';
        } else if (diffDays <= 7) {
          dot = '🔵';
          timeStr = 'due in ' + diffDays + ' days';
        } else if (diffDays <= 14) {
          dot = '🟢';
          timeStr = 'due in ' + diffDays + ' days';
        } else {
          dot = '🟢';
          var diffWeeks = Math.floor(diffDays / 7);
          timeStr = 'due in ' + diffWeeks + ' week' + (diffWeeks > 1 ? 's' : '');
        }
        label = prefix + taskName + '   ' + dot + ' ' + timeStr;
      }

      if (t.dueDate) {
        var dateStr = String(t.dueDate).substring(0, 10); // strip to YYYY-MM-DD
        var d = new Date(dateStr + 'T00:00:00');
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        sub += 'Due: ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
      }
      if (t.assignee) sub += (sub ? ' · ' : '') + '👤 ' + t.assignee;
      if (t.watchers && t.watchers.length) sub += (sub ? ' · ' : '') + '👀 ' + t.watchers.map(function(w) { return w.name; }).join(', ');
      if (t.assignedTeam) sub += (sub ? ' · ' : '') + '👥 ' + t.assignedTeam;
      sub += (sub ? ' · ' : '') + getTaskStatusLabel(t.isCompleted, t.awaitingFollowUp);
      if (t.createdBy) sub += (sub ? ' · ' : '') + 'Added by ' + t.createdBy;
      if (t.followUpCount) {
        sub += (sub ? ' · ' : '') + '🚩 Followed up ' + t.followUpCount + 'x' + (t.followUpDate ? ' · last ' + getRelativeDateLabel(t.followUpDate) : '');
      }
      if (t.scheduledFollowUpDate) sub += (sub ? ' · ' : '') + '📅 Follow-up scheduled ' + getRelativeDateLabel(t.scheduledFollowUpDate);
      if (t.notes) sub += (sub ? ' · ' : '') + '📝 ' + t.notes;
    }

    var dt = CardService.newDecoratedText().setText(label).setWrapText(true);
    if (sub) dt.setBottomLabel(sub);

    var taskParams = {
      taskId: t.id,
      taskName: t.name,
      taskIsCompleted: t.isCompleted ? 'true' : 'false',
      taskDue: t.dueDate || '',
      taskTime: t.dueTime || '',
      taskStatus: t.statusId || '',
      taskAssignee: t.assigneeId || '',
      taskTeam: t.assignedTeamId || '',
      taskMonetary: t.isMonetary ? 'true' : 'false',
      taskCost: t.estimatedCost ? String(t.estimatedCost) : '',
      taskAwaitingFollowUp: t.awaitingFollowUp ? 'true' : 'false',
      taskFollowUpDate: t.followUpDate || '',
      taskFollowUpCount: String(t.followUpCount || 0),
      taskNotes: t.notes || '',
      taskSourceMessageId: t.sourceMessageId || '',
      taskSourceEmailSubject: t.sourceEmailSubject || '',
      taskSourceEmailBody: t.sourceEmailBody || '',
      taskWatcherIds: (t.watchers || []).map(function(w) { return w.id; }).join(','),
      taskSyncToCompanyCalendar: t.syncToCompanyCalendar ? 'true' : 'false',
      projectId: projectId,
      projectName: projectName,
      labelCode: labelCode,
      companyId: companyId,
      messageId: messageId || '',
      accessToken: token,
    };

    dt.setButton(CardService.newImageButton()
      .setIconUrl(t.isCompleted
        ? 'https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsoutlined/check_circle/default/24px.svg'
        : 'https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsoutlined/radio_button_unchecked/default/24px.svg')
      .setAltText(t.isCompleted ? 'Mark incomplete' : 'Mark complete')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onToggleTask')
        .setParameters(Object.assign({}, taskParams, {
          isCompleted: t.isCompleted ? 'false' : 'true',
        }))));

    // Tap task name → edit card
    dt.setOnClickAction(CardService.newAction()
      .setFunctionName('onOpenEditTask')
      .setParameters(taskParams));

    taskSection.addWidget(dt);

    if (!tasksSimplified) {
      // Reference email — the subject/body text is stored on the task itself
      // (message IDs don't resolve across different users' mailboxes, so a
      // deep link back to the original email only ever works for whoever
      // linked it — plain text works for everyone).
      if (t.sourceEmailSubject) {
        taskSection.addWidget(CardService.newTextParagraph()
          .setText('📧 <b>' + escapeCardHtml(t.sourceEmailSubject) + '</b>'));
      }

      // Second tick — "done on our end, awaiting follow-up" — and a note button,
      // shown on the same row.
      var taskButtonRow = CardService.newButtonSet()
        .addButton(CardService.newTextButton()
          .setText(t.followUpCount ? '🚩 Followed up ' + t.followUpCount + 'x — manage'
            : t.scheduledFollowUpDate ? '📅 Follow-up scheduled — manage'
            : '🏳️ Log follow-up')
          .setOnClickAction(CardService.newAction()
            .setFunctionName('onOpenFollowUpsCard')
            .setParameters(taskParams)))
        .addButton(CardService.newTextButton()
          .setText(t.notes ? '📝 Edit note' : '📝 Add note')
          .setOnClickAction(CardService.newAction()
            .setFunctionName('onOpenNoteCard')
            .setParameters(taskParams)));

      // Capture the email currently open in Gmail as this task's reference —
      // offer to replace it if one's already linked, or link it fresh.
      if (messageId && messageId !== t.sourceMessageId) {
        taskButtonRow.addButton(CardService.newTextButton()
          .setText(t.sourceEmailSubject ? '🔄 Replace with this email' : '📎 Link this email')
          .setOnClickAction(CardService.newAction()
            .setFunctionName('onLinkEmail')
            .setParameters(taskParams)));
      }

      taskSection.addWidget(taskButtonRow);
    }
  }
  card.addSection(taskSection);

  // ── Templates section ────────────────────────────────────────────
  if (templates.length > 0) {
    var templateSection = CardService.newCardSection()
      .setHeader('Apply task template')
      .setCollapsible(true)
      .setNumUncollapsibleWidgets(0);

    var templateSelect = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('selectedTemplateId')
      .setTitle('Choose template');
    templateSelect.addItem('', '', true);
    for (var tmpl = 0; tmpl < templates.length; tmpl++) {
      var t = templates[tmpl];
      var itemCount = (t.items || []).length;
      templateSelect.addItem(t.name + ' (' + itemCount + ' tasks)', t.id, false);
    }
    templateSection.addWidget(templateSelect);

    templateSection.addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('Apply template')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setBackgroundColor('#4f46e5')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onApplyTemplate')
          .setParameters({
            projectId: projectId,
            projectName: projectName,
            companyId: companyId,
            labelCode: labelCode,
            messageId: messageId || '',
            accessToken: token,
          }))));

    card.addSection(templateSection);
  }

  // Add task form
  var addSection = CardService.newCardSection()
    .setHeader('Add task');

  // Task name (required)
  addSection.addWidget(CardService.newTextInput()
    .setFieldName('newTaskName')
    .setTitle('Task name *')
    .setValue(newTaskDraft.name || ''));

  // Reference email — link the email currently open in Gmail, so anyone
  // looking at the task later can jump straight back to it. On by default
  // when there's an email open; only shown when there is one.
  if (messageId) {
    addSection.addWidget(CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.CHECK_BOX)
      .setFieldName('newTaskLinkEmail')
      .setTitle('')
      .addItem('📎 Link the email I\'m viewing', 'true', newTaskDraft.linkEmail !== false));
    addSection.addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('📧 Preview email')
        .setOpenLink(CardService.newOpenLink().setUrl(gmailMessageUrl(messageId)))));
  }

  // Due date — "Specific date" or "Days from" a date (calendar/business, AU state-aware).
  // All fields are always shown and editable — the dropdown only decides which
  // ones get used at submit time — so nothing here ever needs a refresh.
  addSection.addWidget(CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName('newTaskDueMode')
    .setTitle('Due date type')
    .addItem('Specific date', 'specific', (newTaskDraft.dueMode || 'specific') === 'specific')
    .addItem('Days from a date', 'days_from', newTaskDraft.dueMode === 'days_from'));

  // Shared date picker — the due date itself in "specific" mode, or the
  // "from" date to add days to in "days from" mode. Left blank by default
  // (matching the old "specific date" picker) so a task can still be
  // created with no due date at all; "days from" falls back to today at
  // submit time (see onCreateTask) if left untouched.
  var dueDatePicker = CardService.newDatePicker()
    .setFieldName('newTaskDue')
    .setTitle('Due date / from date');
  if (newTaskDraft.dueDate) {
    dueDatePicker.setValueInMsSinceEpoch(new Date(newTaskDraft.dueDate + 'T00:00:00').getTime());
  }
  addSection.addWidget(dueDatePicker);

  addSection.addWidget(CardService.newTextInput()
    .setFieldName('newTaskDaysFromDays')
    .setTitle('Days (only used for "Days from a date")')
    .setValue(newTaskDraft.days != null ? String(newTaskDraft.days) : '7'));

  var dfType = newTaskDraft.dayType || 'calendar';
  addSection.addWidget(CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName('newTaskDaysFromType')
    .setTitle('Type')
    .addItem('Calendar days', 'calendar', dfType === 'calendar')
    .addItem('Business days', 'business', dfType === 'business'));

  var dfStateSelect = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName('newTaskDaysFromState')
    .setTitle('State (used for business days public holidays)');
  for (var dsi = 0; dsi < AU_STATES.length; dsi++) {
    dfStateSelect.addItem(AU_STATES[dsi], AU_STATES[dsi], (newTaskDraft.state || 'NSW') === AU_STATES[dsi]);
  }
  addSection.addWidget(dfStateSelect);

  var dueTimePicker = CardService.newTimePicker()
    .setFieldName('newTaskTime')
    .setTitle('Due time');
  if (newTaskDraft.dueTime) {
    var dtp = newTaskDraft.dueTime.split(':');
    if (dtp.length >= 2) dueTimePicker.setHours(parseInt(dtp[0])).setMinutes(parseInt(dtp[1]));
  } else {
    dueTimePicker.setHours(9).setMinutes(0);
  }
  addSection.addWidget(dueTimePicker);

  // Person responsible (team members)
  if (profiles.length) {
    var assigneeSelect = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('newTaskAssignee')
      .setTitle('Person responsible');
    assigneeSelect.addItem('', '', true);
    for (var pi = 0; pi < profiles.length; pi++) {
      var p = profiles[pi];
      assigneeSelect.addItem(p.full_name || p.email || 'Unknown', p.id, false);
    }
    addSection.addWidget(assigneeSelect);
  }

  // Watchers — extra people who see this task and get notified, without
  // being responsible for it.
  if (profiles.length) {
    var newWatcherSelect = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.MULTI_SELECT)
      .setFieldName('newTaskWatchers')
      .setTitle('Watchers');
    for (var wi = 0; wi < profiles.length; wi++) {
      var wp = profiles[wi];
      newWatcherSelect.addItem(wp.full_name || wp.email || 'Unknown', wp.id, false);
    }
    addSection.addWidget(newWatcherSelect);
  }

  // Assigned team
  if (teams.length) {
    var teamSelect = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('newTaskTeam')
      .setTitle('Assigned team');
    teamSelect.addItem('', '', true);
    for (var ti = 0; ti < teams.length; ti++) {
      teamSelect.addItem(teams[ti].team_name, teams[ti].id, false);
    }
    addSection.addWidget(teamSelect);
  }

  // Reminder
  if (reminderOptions.length) {
    var reminderSelect = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('newTaskReminder')
      .setTitle('Reminder');
    for (var ri = 0; ri < reminderOptions.length; ri++) {
      reminderSelect.addItem(reminderOptions[ri].label, reminderOptions[ri].value, ri === 0);
    }
    addSection.addWidget(reminderSelect);
  }

  // Monetary flag
  addSection.addWidget(CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.CHECK_BOX)
    .setFieldName('newTaskMonetary')
    .setTitle('')
    .addItem('Monetary task', 'true', false));

  // Estimated cost (shown always, user fills if monetary)
  addSection.addWidget(CardService.newTextInput()
    .setFieldName('newTaskCost')
    .setTitle('Estimated cost ($)')
    );

  // Company calendar — in addition to whatever company-wide setting is on,
  // this task can individually opt into also syncing to the company's
  // source-email calendar.
  addSection.addWidget(CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.CHECK_BOX)
    .setFieldName('newTaskSyncToCompanyCalendar')
    .setTitle('')
    .addItem('📅 Also add to company calendar', 'true', false));

  // Submit button
  addSection.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText('Add task')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setBackgroundColor('#4f46e5')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onCreateTask')
        .setParameters({
          projectId: projectId,
          projectName: projectName,
          companyId: companyId,
          labelCode: labelCode,
          messageId: messageId || '',
          accessToken: token,
        }))));
  Logger.log('[buildTaskCardById] addSection done, building card');
  card.addSection(addSection);

  // Back button — uses popCard so no URL confirmation dialog appears
  card.addSection(CardService.newCardSection()
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('← Back')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onPopCard')
          .setParameters({})))));
  Logger.log('[buildTaskCardById] card.build() complete, returning');
  return card.build();
}

function onApplyTemplate(e) {
  var token = e.parameters.accessToken || getToken();
  var templateId = ((e.formInputs.selectedTemplateId || [''])[0] || '').trim();
  var projectId = e.parameters.projectId;
  var projectName = e.parameters.projectName || '';
  var companyId = e.parameters.companyId;
  var labelCode = e.parameters.labelCode || '';
  var messageId = e.parameters.messageId || null;

  if (!templateId) return errorNotification('Please select a template first');

  // Get project created_at for date offset calculation
  var projectRes = apiGet('/project-by-label?code=' + labelCode + '&companyId=' + companyId, token);
  var projectCreatedAt = null;
  if (projectRes.ok && projectRes.data.project) {
    projectCreatedAt = projectRes.data.project.created_at || null;
  }

  var result = apiPost('/apply-template', {
    templateId: templateId,
    projectId: projectId,
    companyId: companyId,
    projectCreatedAt: projectCreatedAt,
  }, token);

  if (!result.ok || !result.data.ok) {
    return errorNotification('Error: ' + (result.data.error || 'Could not apply template'));
  }

  var count = result.data.count || 0;
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .updateCard(buildTaskCardById(projectId, projectName, labelCode, companyId, token, messageId)))
    .setNotification(CardService.newNotification()
      .setText('✓ Applied template — ' + count + ' task' + (count !== 1 ? 's' : '') + ' created'))
    .build();
}

function onPopCard(e) {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().popCard())
    .build();
}

function onBackFromTasks(e) {
  var token = e.parameters.accessToken || getToken();
  var messageId = e.parameters.messageId || null;
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(buildMainCard(messageId, token)))
    .build();
}

// ── Browse labelled projects to view tasks ─────────────────────────

function onShowProjectsForTasks(e) {
  return buildProjectsForTasksCard(e.parameters, e.formInputs || {});
}

function onFilterProjectsForTasks(e) {
  return buildProjectsForTasksCard(e.parameters, e.formInputs || {});
}

function buildProjectsForTasksCard(params, formInputs) {
  var token = params.accessToken || getToken();
  var companyId = params.companyId || '';
  var query = ((formInputs.taskProjectQuery || [params.query || '']))[0] || '';

  var url = '/search-projects?labelled=true&companyId=' + companyId;
  if (query) url += '&q=' + encodeURIComponent(query);
  var result = apiGet(url, token);
  var projects = (result.ok ? result.data.projects : []) || [];

  var card = CardService.newCardBuilder()
    .setName('projectsForTasks')
    .setHeader(CardService.newCardHeader()
      .setTitle('Diract')
      .setSubtitle('Select a project (' + projects.length + ')'));

  card.addSection(CardService.newCardSection()
    .addWidget(CardService.newTextInput()
      .setFieldName('taskProjectQuery')
      .setTitle('Search project')

      .setValue(query))
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('Search')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onFilterProjectsForTasks')
          .setParameters({ accessToken: token, companyId: companyId })))));

  if (!projects.length) {
    card.addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph()
        .setText(query ? 'No projects found for "' + query + '"' : 'No labelled projects found.')));
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().pushCard(card.build()))
      .build();
  }

  var listSection = CardService.newCardSection().setHeader('Select a project');
  for (var pi = 0; pi < projects.length; pi++) {
    var p = projects[pi];
    listSection.addWidget(CardService.newDecoratedText()
      .setText(p.name)
      .setBottomLabel((p.status || '') + (p.labelName ? ' · ' + p.labelName : ''))
      .setButton(CardService.newTextButton()
        .setText('Tasks →')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onViewTasks')
          .setParameters({
            projectId: p.id,
            projectName: p.name,
            labelCode: p.labelCode || '',
            companyId: companyId,
            messageId: '',
            accessToken: token,
          }))));
  }
  card.addSection(listSection);

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(card.build()))
    .build();
}

function onToggleTask(e) {
  var token = e.parameters.accessToken || getToken();
  var result = apiPost('/toggle-task', {
    taskId: e.parameters.taskId,
    isCompleted: e.parameters.isCompleted === 'true',
  }, token);
  if (!result.ok) return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .updateCard(buildTaskCardById(
        e.parameters.projectId, e.parameters.projectName,
        e.parameters.labelCode, e.parameters.companyId,
        token, e.parameters.messageId || null)))
    .build();
}

// Follow-ups are a dated log, not a single tick — a task can be followed
// up more than once (e.g. chasing the same person repeatedly). Tapping the
// row's follow-up button always opens this manage card: past entries with
// a remove button each, plus a date field to log a new one.
function onOpenFollowUpsCard(e) {
  var token = e.parameters.accessToken || getToken();
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .pushCard(buildFollowUpsCard(e.parameters, token)))
    .build();
}

function buildFollowUpsCard(params, token) {
  var card = CardService.newCardBuilder()
    .setName('follow_ups_' + params.taskId)
    .setHeader(CardService.newCardHeader()
      .setTitle('Follow-ups')
      .setSubtitle(params.taskName || ''));

  var section = CardService.newCardSection();
  var res = apiGet('/task-follow-ups?taskId=' + params.taskId, token);
  var entries = res.ok ? (res.data.entries || []) : [];
  // Scheduled (not-yet-done) entries first, then done ones newest-first.
  entries.sort(function(a, b) {
    if (a.isDone !== b.isDone) return a.isDone ? 1 : -1;
    return a.followedUpAt < b.followedUpAt ? 1 : -1;
  });

  if (!entries.length) {
    section.addWidget(CardService.newTextParagraph().setText('No follow-ups logged yet.'));
  } else {
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (entry.isDone) {
        section.addWidget(CardService.newDecoratedText()
          .setText(entry.followedUpAt)
          .setButton(CardService.newImageButton()
            .setIconUrl('https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsoutlined/close/default/24px.svg')
            .setAltText('Remove')
            .setOnClickAction(CardService.newAction()
              .setFunctionName('onRemoveFollowUpEntry')
              .setParameters(Object.assign({}, params, { followUpId: entry.id })))));
      } else {
        section.addWidget(CardService.newDecoratedText()
          .setText('📅 ' + entry.followedUpAt + ' · scheduled'));
        section.addWidget(CardService.newButtonSet()
          .addButton(CardService.newTextButton()
            .setText('✓ Mark done')
            .setOnClickAction(CardService.newAction()
              .setFunctionName('onMarkFollowUpEntryDone')
              .setParameters(Object.assign({}, params, { followUpId: entry.id }))))
          .addButton(CardService.newTextButton()
            .setText('Remove')
            .setOnClickAction(CardService.newAction()
              .setFunctionName('onRemoveFollowUpEntry')
              .setParameters(Object.assign({}, params, { followUpId: entry.id })))));
      }
    }
  }

  var newDatePicker = CardService.newDatePicker()
    .setFieldName('followUpDate')
    .setTitle('Date followed up (future = scheduled)')
    .setValueInMsSinceEpoch(dateStrToUtcMidnight(todayDateStr()).getTime());
  section.addWidget(newDatePicker);
  section.addWidget(CardService.newTextParagraph()
    .setText('A future date schedules the follow-up (tick it off later) and moves the task\'s due date to match.'));
  section.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText('Log / schedule follow-up')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setBackgroundColor('#f59e0b')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onAddFollowUpEntry')
        .setParameters(params))));

  card.addSection(section);

  card.addSection(CardService.newCardSection()
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('← Back')
        .setOnClickAction(CardService.newAction()
          .setFunctionName(params.fromEditCard === 'true' ? 'onCloseFollowUpsCardFromEdit' : 'onCloseFollowUpsCard')
          .setParameters(params)))));

  return card.build();
}

function onAddFollowUpEntry(e) {
  var token = e.parameters.accessToken || getToken();
  var followedUpAt = parseDatePickerValue(e, 'followUpDate') || todayDateStr();

  var result = apiPost('/add-follow-up', { taskId: e.parameters.taskId, followedUpAt: followedUpAt }, token);
  if (!result.ok) return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  invalidateTaskCache(e.parameters.companyId);
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(buildFollowUpsCard(e.parameters, token)))
    .setNotification(CardService.newNotification().setText('🚩 Follow-up logged'))
    .build();
}

function onRemoveFollowUpEntry(e) {
  var token = e.parameters.accessToken || getToken();
  var result = apiPost('/remove-follow-up', { taskId: e.parameters.taskId, followUpId: e.parameters.followUpId }, token);
  if (!result.ok) return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  invalidateTaskCache(e.parameters.companyId);
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(buildFollowUpsCard(e.parameters, token)))
    .build();
}

function onMarkFollowUpEntryDone(e) {
  var token = e.parameters.accessToken || getToken();
  var result = apiPost('/mark-follow-up-done', { taskId: e.parameters.taskId, followUpId: e.parameters.followUpId }, token);
  if (!result.ok) return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  invalidateTaskCache(e.parameters.companyId);
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(buildFollowUpsCard(e.parameters, token)))
    .setNotification(CardService.newNotification().setText('✓ Follow-up marked done'))
    .build();
}

// Back out of the manage-follow-ups card to the (now stale) task list —
// rebuild it fresh so the updated follow-up count/status shows immediately.
function onCloseFollowUpsCard(e) {
  var token = e.parameters.accessToken || getToken();
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .popCard()
      .updateCard(buildTaskCardById(
        e.parameters.projectId, e.parameters.projectName,
        e.parameters.labelCode, e.parameters.companyId,
        token, e.parameters.messageId || null)))
    .build();
}

// Same, but for when the manage-follow-ups card was opened from the edit-
// task card — pops both levels (follow-ups card, then edit card) back to
// the refreshed task list.
function onCloseFollowUpsCardFromEdit(e) {
  var token = e.parameters.accessToken || getToken();
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .popCard()
      .popCard()
      .updateCard(buildTaskCardById(
        e.parameters.projectId, e.parameters.projectName,
        e.parameters.labelCode, e.parameters.companyId,
        token, e.parameters.messageId || null)))
    .build();
}

// Note editor — a small pushed card with a single text area, saved via a
// dedicated endpoint so it doesn't require re-submitting the whole task.
function onOpenNoteCard(e) {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .pushCard(buildNoteCard(e.parameters)))
    .build();
}

function buildNoteCard(params) {
  var card = CardService.newCardBuilder()
    .setName('note_' + params.taskId)
    .setHeader(CardService.newCardHeader()
      .setTitle('Task note')
      .setSubtitle(params.taskName || ''));

  var section = CardService.newCardSection();
  section.addWidget(CardService.newTextInput()
    .setFieldName('taskNoteText')
    .setTitle('Note')
    .setMultiline(true)
    .setValue(params.taskNotes || ''));

  section.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText('Save')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setBackgroundColor('#4f46e5')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onSaveNote')
        .setParameters(params)))
    .addButton(CardService.newTextButton()
      .setText('← Back')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onPopCard')
        .setParameters({}))));

  card.addSection(section);
  return card.build();
}

function onSaveNote(e) {
  var token = e.parameters.accessToken || getToken();
  var noteText = ((e.formInputs.taskNoteText || [''])[0] || '').trim();

  var result = apiPost('/update-notes', {
    taskId: e.parameters.taskId,
    notes: noteText || null,
  }, token);
  if (!result.ok) return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .popCard()
      .updateCard(buildTaskCardById(
        e.parameters.projectId, e.parameters.projectName,
        e.parameters.labelCode, e.parameters.companyId,
        token, e.parameters.messageId || null)))
    .setNotification(CardService.newNotification().setText('✓ Note saved'))
    .build();
}

// Attaches the email currently open in Gmail to a task as its reference —
// so anyone looking at the task later can jump straight back to the email
// that prompted it.
function onLinkEmail(e) {
  var token = e.parameters.accessToken || getToken();
  if (!e.parameters.messageId) return errorNotification('No email is open to link');
  var emailContent = fetchMessageContent(token, e.parameters.messageId);

  var result = apiPost('/link-email', {
    taskId: e.parameters.taskId,
    messageId: e.parameters.messageId,
    emailSubject: emailContent ? emailContent.subject : null,
    emailBody: emailContent ? emailContent.body : null,
  }, token);
  if (!result.ok) return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .updateCard(buildTaskCardById(
        e.parameters.projectId, e.parameters.projectName,
        e.parameters.labelCode, e.parameters.companyId,
        token, e.parameters.messageId || null)))
    .setNotification(CardService.newNotification().setText('📎 Email linked to task'))
    .build();
}

// Same as onLinkEmail, but for the button inside the pushed edit-task card
// — pops back to the (now updated) task list instead of updating in place.
function onLinkEmailFromEditCard(e) {
  var token = e.parameters.accessToken || getToken();
  if (!e.parameters.messageId) return errorNotification('No email is open to link');
  var emailContent = fetchMessageContent(token, e.parameters.messageId);

  var result = apiPost('/link-email', {
    taskId: e.parameters.taskId,
    messageId: e.parameters.messageId,
    emailSubject: emailContent ? emailContent.subject : null,
    emailBody: emailContent ? emailContent.body : null,
  }, token);
  if (!result.ok) return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .popCard()
      .updateCard(buildTaskCardById(
        e.parameters.projectId, e.parameters.projectName,
        e.parameters.labelCode, e.parameters.companyId,
        token, e.parameters.messageId || null)))
    .setNotification(CardService.newNotification().setText('📎 Email linked to task'))
    .build();
}

function onOpenEditTask(e) {
  var token = e.parameters.accessToken || getToken();
  var ctxRes = apiGet('/task-context?companyId=' + e.parameters.companyId, token);
  var statuses = ctxRes.ok ? (ctxRes.data.statuses || []) : [];
  var profiles = ctxRes.ok ? (ctxRes.data.profiles || []) : [];
  var teams = ctxRes.ok ? (ctxRes.data.teams || []) : [];
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .pushCard(buildEditTaskCard(e.parameters, statuses, profiles, teams)))
    .build();
}

function buildEditTaskCard(params, statuses, profiles, teams) {
  var card = CardService.newCardBuilder()
    .setName('edit_task_' + params.taskId)
    .setHeader(CardService.newCardHeader()
      .setTitle('Edit task')
      .setSubtitle(params.taskName || ''));

  var section = CardService.newCardSection();

  // Task name
  section.addWidget(CardService.newTextInput()
    .setFieldName('editTaskName')
    .setTitle('Task name *')
    .setValue(params.taskName || ''));

  // Reference email — subject/body text captured from the message that
  // prompted this task, stored so every viewer can read it (message IDs
  // don't resolve across different users' mailboxes, so a deep link back
  // to the original email would only ever work for whoever linked it).
  if (params.taskSourceEmailSubject) {
    section.addWidget(CardService.newTextParagraph()
      .setText('📧 <b>' + escapeCardHtml(params.taskSourceEmailSubject) + '</b>' +
        (params.taskSourceEmailBody ? '<br>' + escapeCardHtml(params.taskSourceEmailBody) : '')));
  }
  if (params.messageId && params.messageId !== params.taskSourceMessageId) {
    section.addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText(params.taskSourceEmailSubject ? '🔄 Replace with this email' : '📎 Link this email')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onLinkEmailFromEditCard')
          .setParameters(params))));
  }

  // Due date — "Specific date" or "Days from" a date (calendar/business, AU state-aware).
  // All fields are always shown and editable — the dropdown only decides which
  // ones get used at submit time — so nothing here ever needs a refresh.
  var editDueMode = params.taskDueMode || 'specific';
  section.addWidget(CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName('editTaskDueMode')
    .setTitle('Due date type')
    .addItem('Specific date', 'specific', editDueMode === 'specific')
    .addItem('Days from a date', 'days_from', editDueMode === 'days_from'));

  // Shared date picker — the due date itself in "specific" mode, or the
  // "from" date to add days to in "days from" mode. Pre-filled with the
  // task's current due date either way.
  var datePicker = CardService.newDatePicker()
    .setFieldName('editTaskDue')
    .setTitle('Due date / from date');
  var editDueDateStr = params.taskDue || params.taskDaysFromDate;
  var editDueDateMs = editDueDateStr ? new Date(editDueDateStr + 'T00:00:00').getTime() : dateStrToUtcMidnight(todayDateStr()).getTime();
  datePicker.setValueInMsSinceEpoch(editDueDateMs);
  section.addWidget(datePicker);

  section.addWidget(CardService.newTextInput()
    .setFieldName('editTaskDaysFromDays')
    .setTitle('Days (only used for "Days from a date")')
    .setValue(params.taskDaysFromDays || '7'));

  var editDfType = params.taskDayType || 'calendar';
  section.addWidget(CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName('editTaskDaysFromType')
    .setTitle('Type')
    .addItem('Calendar days', 'calendar', editDfType === 'calendar')
    .addItem('Business days', 'business', editDfType === 'business'));

  var editDfStateSelect = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName('editTaskDaysFromState')
    .setTitle('State (used for business days public holidays)');
  for (var edsi = 0; edsi < AU_STATES.length; edsi++) {
    editDfStateSelect.addItem(AU_STATES[edsi], AU_STATES[edsi], (params.taskDaysFromState || 'NSW') === AU_STATES[edsi]);
  }
  section.addWidget(editDfStateSelect);

  // Due time picker
  var timePicker = CardService.newTimePicker()
    .setFieldName('editTaskTime')
    .setTitle('Due time');
  if (params.taskTime) {
    var tp = params.taskTime.split(':');
    if (tp.length >= 2) {
      timePicker.setHours(parseInt(tp[0])).setMinutes(parseInt(tp[1]));
    }
  } else {
    timePicker.setHours(9).setMinutes(0);
  }
  section.addWidget(timePicker);

  // Status — automatic, not user-set (Pending / Follow Up / Complete)
  section.addWidget(CardService.newDecoratedText()
    .setTopLabel('Status')
    .setText(getTaskStatusLabel(params.taskIsCompleted === 'true', params.taskAwaitingFollowUp === 'true')));

  // Assignee
  if (profiles.length) {
    var assigneeSelect = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('editTaskAssignee')
      .setTitle('Person responsible');
    assigneeSelect.addItem('', '', !params.taskAssignee);
    for (var pi = 0; pi < profiles.length; pi++) {
      var p = profiles[pi];
      assigneeSelect.addItem(p.full_name || p.email || 'Unknown', p.id, params.taskAssignee === p.id);
    }
    section.addWidget(assigneeSelect);
  }

  // Watchers — extra people who see this task and get notified, without
  // being responsible for it.
  if (profiles.length) {
    var editWatcherIds = params.taskWatcherIds ? params.taskWatcherIds.split(',') : [];
    var editWatcherSelect = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.MULTI_SELECT)
      .setFieldName('editTaskWatchers')
      .setTitle('Watchers');
    for (var wi = 0; wi < profiles.length; wi++) {
      var wp = profiles[wi];
      editWatcherSelect.addItem(wp.full_name || wp.email || 'Unknown', wp.id, editWatcherIds.indexOf(wp.id) !== -1);
    }
    section.addWidget(editWatcherSelect);
  }

  // Team
  if (teams.length) {
    var teamSelect = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('editTaskTeam')
      .setTitle('Assigned team');
    teamSelect.addItem('', '', !params.taskTeam);
    for (var ti = 0; ti < teams.length; ti++) {
      teamSelect.addItem(teams[ti].team_name, teams[ti].id, params.taskTeam === teams[ti].id);
    }
    section.addWidget(teamSelect);
  }

  // Monetary
  section.addWidget(CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.CHECK_BOX)
    .setFieldName('editTaskMonetary')
    .setTitle('')
    .addItem('Monetary task', 'true', params.taskMonetary === 'true'));

  // Cost
  section.addWidget(CardService.newTextInput()
    .setFieldName('editTaskCost')
    .setTitle('Estimated cost ($)')
    .setValue(params.taskCost || ''));

  // Company calendar — in addition to whatever company-wide setting is on,
  // this task can individually opt into also syncing to the company's
  // source-email calendar.
  section.addWidget(CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.CHECK_BOX)
    .setFieldName('editTaskSyncToCompanyCalendar')
    .setTitle('')
    .addItem('📅 Also add to company calendar', 'true', params.taskSyncToCompanyCalendar === 'true'));

  // Follow-ups — a task can be followed up more than once, so this opens
  // the same dated log/manage card used from the task list row.
  section.addWidget(CardService.newDecoratedText()
    .setTopLabel('Follow-ups')
    .setText(params.taskFollowUpCount && params.taskFollowUpCount !== '0'
      ? 'Followed up ' + params.taskFollowUpCount + 'x'
      : 'Not followed up yet')
    .setButton(CardService.newTextButton()
      .setText('Manage')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onOpenFollowUpsCard')
        .setParameters(Object.assign({}, params, { fromEditCard: 'true' })))));

  // Notes
  section.addWidget(CardService.newTextInput()
    .setFieldName('editTaskNotes')
    .setTitle('Notes')
    .setMultiline(true)
    .setValue(params.taskNotes || ''));

  // Save + Delete buttons
  section.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText('Save changes')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setBackgroundColor('#4f46e5')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onUpdateTask')
        .setParameters(params)))
    .addButton(CardService.newTextButton()
      .setText('Delete')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setBackgroundColor('#dc2626')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onDeleteTask')
        .setParameters(params))));

  section.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText('🕘 History')
      .setOnClickAction(CardService.newAction()
        .setFunctionName('onOpenTaskHistory')
        .setParameters(params))));

  card.addSection(section);

  card.addSection(CardService.newCardSection()
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('← Back')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onPopCard')
          .setParameters({})))));

  return card.build();
}

// Task history — who created/changed/noted this task, and when.
function onOpenTaskHistory(e) {
  var token = e.parameters.accessToken || getToken();
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .pushCard(buildTaskHistoryCard(e.parameters, token)))
    .build();
}

var TASK_HISTORY_ACTION_LABELS = {
  created: 'created this task',
  updated: 'updated this task',
  completed: 'marked this task complete',
  reopened: 'marked this task incomplete',
  follow_up_set: 'marked this task awaiting follow-up',
  follow_up_cleared: 'cleared the follow-up flag',
  note_updated: 'updated the note',
  email_linked: 'linked a reference email',
  deleted: 'deleted this task',
};

function buildTaskHistoryCard(params, token) {
  var card = CardService.newCardBuilder()
    .setName('task_history_' + params.taskId)
    .setHeader(CardService.newCardHeader()
      .setTitle('Task history')
      .setSubtitle(params.taskName || ''));

  var section = CardService.newCardSection();
  var res = apiGet('/task-history?taskId=' + params.taskId, token);
  var entries = res.ok ? (res.data.entries || []) : [];

  if (!entries.length) {
    section.addWidget(CardService.newTextParagraph().setText('No activity yet.'));
  } else {
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var when = new Date(entry.createdAt);
      var whenStr = Utilities.formatDate(when, APP_TIMEZONE, 'd MMM yyyy, h:mm a');
      var label = TASK_HISTORY_ACTION_LABELS[entry.action] || entry.action;
      var dt = CardService.newDecoratedText()
        .setText(entry.actorName + ' ' + label + (entry.detail ? ' — ' + entry.detail : ''))
        .setBottomLabel(whenStr)
        .setWrapText(true);
      section.addWidget(dt);
    }
  }
  card.addSection(section);

  card.addSection(CardService.newCardSection()
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('← Back')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onPopCard')
          .setParameters({})))));

  return card.build();
}

function onUpdateTask(e) {
  var token = e.parameters.accessToken || getToken();
  var name = ((e.formInputs.editTaskName || [''])[0] || '').trim();
  var statusId = ((e.formInputs.editTaskStatus || [''])[0] || '');
  var assigneeId = ((e.formInputs.editTaskAssignee || [''])[0] || '');
  var teamId = ((e.formInputs.editTaskTeam || [''])[0] || '');
  var isMonetary = (e.formInputs.editTaskMonetary || []).indexOf('true') !== -1;
  var costRaw = ((e.formInputs.editTaskCost || [''])[0] || '').trim();
  var estimatedCost = costRaw ? parseFloat(costRaw.replace(/,/g, '')) : null;
  var notes = ((e.formInputs.editTaskNotes || [''])[0] || '').trim();
  var watcherIds = e.formInputs.editTaskWatchers || [];
  var syncToCompanyCalendar = (e.formInputs.editTaskSyncToCompanyCalendar || []).indexOf('true') !== -1;

  if (!name) return errorNotification('Task name is required');

  // Due date — either the shared date picker used directly, or as the "from"
  // date for a calendar/business day offset. The picker is always shown
  // pre-filled with the task's current due date, so a null parse here always
  // means we failed to read it out of the event payload, never that the user
  // cleared it — bail rather than silently wiping the existing due date.
  var editDueMode = ((e.formInputs.editTaskDueMode || ['specific'])[0] || 'specific');
  var editParsedDate = parseDatePickerValue(e, 'editTaskDue');
  if (!editParsedDate) return errorNotification('Could not read due date — try again');
  var dueDate = null;
  if (editDueMode === 'days_from') {
    var edfDays = parseInt((e.formInputs.editTaskDaysFromDays || ['0'])[0]) || 0;
    var edfType = (e.formInputs.editTaskDaysFromType || ['calendar'])[0] || 'calendar';
    var edfState = (e.formInputs.editTaskDaysFromState || ['NSW'])[0] || 'NSW';
    dueDate = calculateDueDate(editParsedDate, edfDays, edfType, edfState);
    if (!dueDate) return errorNotification('Could not calculate due date — try again');
  } else {
    dueDate = editParsedDate;
  }
  Logger.log('[onUpdateTask] parsed dueDate=' + dueDate);

  // Parse time picker
  var dueTime = null;
  var dueTimeRaw = e.formInput ? e.formInput['editTaskTime'] : (e.formInputs ? e.formInputs['editTaskTime'] : null);
  if (dueTimeRaw) {
    var th2 = null, tm2 = null;
    try { th2 = parseInt(dueTimeRaw.hours); tm2 = parseInt(dueTimeRaw.minutes || 0); } catch(_e) {}
    Logger.log('[onUpdateTask] time hours=' + th2 + ' mins=' + tm2);
    if (th2 !== null && !isNaN(th2)) {
      dueTime = String(th2).padStart(2, '0') + ':' + String(tm2 || 0).padStart(2, '0');
    }
  }
  Logger.log('[onUpdateTask] parsed dueDate=' + dueDate + ' dueTime=' + dueTime);

  var result = apiPost('/update-task', {
    taskId: e.parameters.taskId,
    name: name,
    dueDate: dueDate,
    dueTime: dueTime,
    statusId: statusId || null,
    assigneeId: assigneeId || null,
    assignedTeamId: teamId || null,
    isMonetary: isMonetary,
    estimatedCost: estimatedCost,
    notes: notes || null,
    watcherIds: watcherIds,
    syncToCompanyCalendar: syncToCompanyCalendar,
  }, token);

  if (!result.ok) return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  invalidateTaskCache(e.parameters.companyId);
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .popCard()
      .updateCard(buildTaskCardById(
        e.parameters.projectId, e.parameters.projectName,
        e.parameters.labelCode, e.parameters.companyId,
        token, e.parameters.messageId || null)))
    .setNotification(CardService.newNotification().setText('✓ Task updated'))
    .build();
}

function onDeleteTask(e) {
  var token = e.parameters.accessToken || getToken();
  var result = apiPost('/delete-task', {
    taskId: e.parameters.taskId,
  }, token);
  if (!result.ok) return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  invalidateTaskCache(e.parameters.companyId);
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .popCard()
      .updateCard(buildTaskCardById(
        e.parameters.projectId, e.parameters.projectName,
        e.parameters.labelCode, e.parameters.companyId,
        token, e.parameters.messageId || null)))
    .setNotification(CardService.newNotification().setText('✓ Task deleted'))
    .build();
}



function onCreateTask(e) {
  var token = e.parameters.accessToken || getToken();
  var name = ((e.formInputs.newTaskName || [''])[0] || '').trim();

  // Due date — either the shared date picker used directly, or as the "from"
  // date for a calendar/business day offset. All fields are always shown;
  // this dropdown just decides which combination applies.
  var dueMode = ((e.formInputs.newTaskDueMode || ['specific'])[0] || 'specific');
  var dueDate = null;
  if (dueMode === 'days_from') {
    var dfDate = parseDatePickerValue(e, 'newTaskDue') || todayDateStr();
    var dfDays = parseInt((e.formInputs.newTaskDaysFromDays || ['0'])[0]) || 0;
    var dfType = (e.formInputs.newTaskDaysFromType || ['calendar'])[0] || 'calendar';
    var dfState = (e.formInputs.newTaskDaysFromState || ['NSW'])[0] || 'NSW';
    dueDate = calculateDueDate(dfDate, dfDays, dfType, dfState);
    if (!dueDate) return errorNotification('Could not calculate due date — try again');
  } else {
    dueDate = parseDatePickerValue(e, 'newTaskDue');
  }
  Logger.log('[onCreateTask] parsed dueDate=' + dueDate);

  // Parse time picker
  var dueTime = null;
  var dueTimeRaw = e.formInput ? e.formInput['newTaskTime'] : (e.formInputs ? e.formInputs['newTaskTime'] : null);
  if (dueTimeRaw) {
    var th = null, tm = null;
    try { th = parseInt(dueTimeRaw.hours); tm = parseInt(dueTimeRaw.minutes || 0); } catch(_e) {}
    Logger.log('[onCreateTask] time hours=' + th + ' mins=' + tm);
    if (th !== null && !isNaN(th)) {
      dueTime = String(th).padStart(2, '0') + ':' + String(tm || 0).padStart(2, '0');
    }
  }
  Logger.log('[onCreateTask] parsed dueTime=' + dueTime);
  var statusId = ((e.formInputs.newTaskStatus || [''])[0] || '');
  var assigneeId = ((e.formInputs.newTaskAssignee || [''])[0] || '');
  var assignedTeamId = ((e.formInputs.newTaskTeam || [''])[0] || '');
  var reminderSetting = ((e.formInputs.newTaskReminder || ['none'])[0] || 'none');
  var isMonetary = (e.formInputs.newTaskMonetary || []).indexOf('true') !== -1;
  var estimatedCostRaw = ((e.formInputs.newTaskCost || [''])[0] || '').trim();

  // ── Validation ─────────────────────────────────────────────────
  if (!name) return errorNotification('Task name is required');

  var estimatedCost = null;
  if (estimatedCostRaw) {
    estimatedCost = parseFloat(estimatedCostRaw.replace(/,/g, ''));
    if (isNaN(estimatedCost)) return errorNotification('Estimated cost must be a number (e.g. 1500.00)');
    if (estimatedCost < 0) return errorNotification('Estimated cost cannot be negative');
  }

  var linkEmail = (e.formInputs.newTaskLinkEmail || []).indexOf('true') !== -1;
  var emailContent = linkEmail ? fetchMessageContent(token, e.parameters.messageId) : null;
  var watcherIds = e.formInputs.newTaskWatchers || [];
  var syncToCompanyCalendar = (e.formInputs.newTaskSyncToCompanyCalendar || []).indexOf('true') !== -1;

  var result = apiPost('/create-task', {
    projectId: e.parameters.projectId,
    companyId: e.parameters.companyId,
    name: name,
    dueDate: dueDate || null,
    dueTime: dueTime || null,
    statusId: statusId || null,
    assigneeId: assigneeId || null,
    assignedTeamId: assignedTeamId || null,
    reminderSetting: reminderSetting !== 'none' ? reminderSetting : null,
    isMonetary: isMonetary,
    estimatedCost: estimatedCost,
    messageId: linkEmail ? (e.parameters.messageId || null) : null,
    emailSubject: emailContent ? emailContent.subject : null,
    emailBody: emailContent ? emailContent.body : null,
    watcherIds: watcherIds,
    syncToCompanyCalendar: syncToCompanyCalendar,
  }, token);

  if (!result.ok || !result.data.ok) return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  invalidateTaskCache(e.parameters.companyId);

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation()
      .updateCard(buildTaskCardById(
        e.parameters.projectId, e.parameters.projectName,
        e.parameters.labelCode, e.parameters.companyId,
        token, e.parameters.messageId || null)))
    .build();
}

// ── Browse projects to import ──────────────────────────────────────

function onShowImportProjects(e) {
  return buildImportCard(e.parameters, e.formInputs || {});
}

function onFilterImportProjects(e) {
  return buildImportCard(e.parameters, e.formInputs || {});
}

function buildImportCard(params, formInputs) {
  var token = params.accessToken || getToken();
  var companyId = params.companyId || '';
  var statusFilter = ((formInputs.importStatusFilter || [params.statusFilter || '']))[0] || '';
  var query = ((formInputs.importQuery || [params.query || '']))[0] || '';
  var page = parseInt(params.page || '0') || 0;

  var url = '/search-projects?labelled=false&companyId=' + companyId + '&page=' + page;
  if (statusFilter) url += '&status=' + encodeURIComponent(statusFilter);
  if (query) url += '&q=' + encodeURIComponent(query);

  var result = apiGet(url, token);
  var projects = (result.ok ? result.data.projects : []) || [];
  var hasMore = result.ok && result.data.hasMore;

  var card = CardService.newCardBuilder()
    .setName('importProjects')
    .setHeader(CardService.newCardHeader()
      .setTitle('Diract')
      .setSubtitle('Import labels — ' + projects.length + ' shown'));

  card.addSection(CardService.newCardSection()
    .setHeader('Filter')
    .addWidget(CardService.newTextInput()
      .setFieldName('importQuery').setTitle('Search')
      .setValue(query))
    .addWidget(CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('importStatusFilter').setTitle('Status')
      .addItem('', '', !statusFilter)
      .addItem('Active', 'active', statusFilter === 'active')
      .addItem('Open', 'Open', statusFilter === 'Open')
      .addItem('In Progress', 'In Progress', statusFilter === 'In Progress')
      .addItem('Completed', 'Completed', statusFilter === 'Completed')
      .addItem('Closed', 'Closed', statusFilter === 'Closed'))
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('Apply filter')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onFilterImportProjects')
          .setParameters({ accessToken: token, companyId: companyId, page: '0' })))));

  if (!result.ok) {
    card.addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph()
        .setText('⚠️ Error: ' + (result.data.error || 'Unknown'))));
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().pushCard(card.build()))
      .build();
  }

  if (!projects.length) {
    card.addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph()
        .setText(query || statusFilter ? 'No projects found.' : 'All projects already have labels.')));
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().pushCard(card.build()))
      .build();
  }

  var displayFields = (result.ok && result.data.displayFields) || ['__name__', 'status'];
  var selection = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.CHECK_BOX)
    .setFieldName('importProjects').setTitle('');

  for (var pi = 0; pi < projects.length; pi++) {
    var p = projects[pi];
    var lines = [];
    for (var fi = 0; fi < displayFields.length; fi++) {
      var fk = displayFields[fi];
      if (fk === '__name__') lines.push(p.name);
      else if (fk === 'status') { if (p.status) lines.push(p.status); }
      else { var val = p.customValues && p.customValues[fk]; if (val) lines.push(val); }
    }
    var mainText = lines[0] || p.name;
    var subText = lines.slice(1, 3).join(' · ');
    selection.addItem(mainText + (subText ? '\n' + subText : ''), p.id, false);
  }

  var listSection = CardService.newCardSection()
    .setHeader('Select projects to import labels for')
    .addWidget(selection)
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('Select all')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onSelectAllImport')
          .setParameters({
            accessToken: token,
            companyId: companyId,
            allIds: (function() { var ids = []; for (var pi2 = 0; pi2 < projects.length; pi2++) { ids.push(projects[pi2].id); } return ids.join(','); })(),
            statusFilter: statusFilter,
            query: query,
          })))
      .addButton(CardService.newTextButton()
        .setText('Import selected')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setBackgroundColor('#4f46e5')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onImportLabels')
          .setParameters({ accessToken: token, companyId: companyId }))));

  card.addSection(listSection);

  if (page > 0 || hasMore) {
    var pageBtns = CardService.newButtonSet();
    if (page > 0) {
      pageBtns.addButton(CardService.newTextButton()
        .setText('← Previous')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onShowImportProjects')
          .setParameters({ accessToken: token, companyId: companyId, statusFilter: statusFilter, query: query, page: String(page - 1) })));
    }
    if (hasMore) {
      pageBtns.addButton(CardService.newTextButton()
        .setText('Next →')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onShowImportProjects')
          .setParameters({ accessToken: token, companyId: companyId, statusFilter: statusFilter, query: query, page: String(page + 1) })));
    }
    card.addSection(CardService.newCardSection().addWidget(pageBtns));
  }

  card.addSection(CardService.newCardSection()
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('⚙ Configure display fields')
        .setTextButtonStyle(CardService.TextButtonStyle.OUTLINED)
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onShowAddonConfig')
          .setParameters({ accessToken: token, companyId: companyId, currentFields: '' })))));

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(card.build()))
    .build();
}

function onSelectAllImport(e) {
  var token = e.parameters.accessToken || getToken();
  var companyId = e.parameters.companyId || '';
  var allIds = (e.parameters.allIds || '').split(',').filter(function(id) { return id; });
  return doImportLabels(allIds, token, companyId);
}

function onImportLabels(e) {
  var selectedIds = e.formInputs.importProjects || [];
  var token = e.parameters.accessToken || getToken();
  var companyId = e.parameters.companyId || '';
  if (!selectedIds.length) return errorNotification('No projects selected');
  return doImportLabels(selectedIds, token, companyId);
}

function doImportLabels(projectIds, token, companyId) {
  var imported = 0;
  var errors = [];
  for (var i = 0; i < projectIds.length; i++) {
    var result = apiPost('/import-label', { projectId: projectIds[i], companyId: companyId }, token);
    if (result.ok && result.data.ok) {
      imported++;
      if (result.data.labelName) createGmailLabel(token, result.data.labelName);
    } else {
      errors.push(result.data.error || 'Unknown');
    }
  }
  var msg = '✓ Created labels for ' + imported + ' project(s)';
  if (errors.length) msg += '. Errors: ' + errors.slice(0, 3).join(', ');
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification()
      .setText(msg)
      .setType(errors.length && !imported ? CardService.NotificationType.ERROR : CardService.NotificationType.INFO))
    .setNavigation(CardService.newNavigation().popCard())
    .build();
}

// ── Filtered import (background job) ──────────────────────────────

function onShowFilteredImport(e) {
  return buildFilteredImportCard(e.parameters, e.formInputs || {}, null);
}

function onFilteredImportPreview(e) {
  var token = e.parameters.accessToken || getToken();
  var companyId = e.parameters.companyId || '';
  var name = ((e.formInputs.filterName || [''])[0] || '').trim();
  var status = ((e.formInputs.filterStatus || [''])[0] || '');
  var filters = {};
  if (name) filters.name = name;
  if (status) filters.status = status;
  var result = apiPost('/count-import', { companyId: companyId, filters: filters }, token);
  if (!result.ok) return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  return buildFilteredImportCard({ accessToken: token, companyId: companyId }, e.formInputs, result.data);
}

function buildFilteredImportCard(params, formInputs, countData) {
  var token = params.accessToken || getToken();
  var companyId = params.companyId || '';
  var name = ((formInputs.filterName || ['']))[0] || '';
  var status = ((formInputs.filterStatus || ['']))[0] || '';

  var card = CardService.newCardBuilder()
    .setName('filteredImport')
    .setHeader(CardService.newCardHeader().setTitle('Diract').setSubtitle('Import labels'));

  card.addSection(CardService.newCardSection()
    .setHeader('Filter projects')
    .addWidget(CardService.newTextInput()
      .setFieldName('filterName').setTitle('Project name').setValue(name))
    .addWidget(CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('filterStatus').setTitle('Status')
      .addItem('All statuses', '', !status)
      .addItem('Open', 'Open', status === 'Open')
      .addItem('Active', 'active', status === 'active')
      .addItem('In Progress', 'In Progress', status === 'In Progress')
      .addItem('Completed', 'Completed', status === 'Completed')
      .addItem('Closed', 'Closed', status === 'Closed'))
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('Preview count')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onFilteredImportPreview')
          .setParameters({ accessToken: token, companyId: companyId })))));

  if (countData) {
    var confirmSection = CardService.newCardSection().setHeader('Ready to import');
    confirmSection.addWidget(CardService.newTextParagraph()
      .setText('📁 Total matching: ' + countData.total + '\n' +
        '🏷 Need labels: ' + countData.unlabelled + '\n' +
        '✓ Already labelled: ' + countData.labelled));
    if (countData.unlabelled > 0) {
      var filters = {};
      if (name) filters.name = name;
      if (status) filters.status = status;
      confirmSection.addWidget(CardService.newButtonSet()
        .addButton(CardService.newTextButton()
          .setText('✓ Confirm — create ' + countData.unlabelled + ' labels')
          .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
          .setBackgroundColor('#4f46e5')
          .setOnClickAction(CardService.newAction()
            .setFunctionName('onConfirmImport')
            .setParameters({
              accessToken: token,
              companyId: companyId,
              filtersJson: JSON.stringify(filters),
            }))));
    } else {
      confirmSection.addWidget(CardService.newTextParagraph()
        .setText('All matching projects already have labels!'));
    }
    card.addSection(confirmSection);
  }

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(card.build()))
    .build();
}

function onConfirmImport(e) {
  var token = e.parameters.accessToken || getToken();
  var companyId = e.parameters.companyId || '';
  var filters = {};
  try { filters = JSON.parse(e.parameters.filtersJson || '{}'); } catch (ex) {}
  var result = apiPost('/queue-import', { companyId: companyId, filters: filters }, token);
  if (!result.ok) {
    if (result.code === 409) return errorNotification('A job is already running. Check main screen.');
    return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  }
  if (result.data.total === 0) return errorNotification('No unlabelled projects match your filters.');
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification()
      .setText('✓ Started! Creating labels for ' + result.data.total + ' projects. Check main screen for progress.')
      .setType(CardService.NotificationType.INFO))
    .setNavigation(CardService.newNavigation().popCard().popCard())
    .build();
}

function onCancelImport(e) {
  var token = e.parameters.accessToken || getToken();
  var result = apiPost('/cancel-import', { jobId: e.parameters.jobId }, token);
  if (!result.ok) return errorNotification('Failed to cancel');
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification()
      .setText('✓ Import cancelled').setType(CardService.NotificationType.INFO))
    .setNavigation(CardService.newNavigation().updateCard(buildMainCard(null, token)))
    .build();
}

function onResumeImport(e) {
  var token = e.parameters.accessToken || getToken();
  var result = apiPost('/resume-import', { jobId: e.parameters.jobId }, token);
  if (!result.ok) return errorNotification('Failed to resume');
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification()
      .setText('▶ Resuming — check main screen for progress.').setType(CardService.NotificationType.INFO))
    .setNavigation(CardService.newNavigation().updateCard(buildMainCard(null, token)))
    .build();
}

// ── Manage / delete labelled projects ─────────────────────────────

function onShowAllProjectsForDelete(e) {
  return buildDeleteCard(e.parameters, e.formInputs || {});
}

function onFilterProjects(e) {
  return buildDeleteCard(e.parameters, e.formInputs || {});
}

function buildDeleteCard(params, formInputs) {
  var token = params.accessToken || getToken();
  var companyId = params.companyId || '';
  var query = ((formInputs.filterQuery || [params.query || '']))[0] || '';

  var url = '/search-projects?labelled=true&companyId=' + companyId;
  if (query) url += '&q=' + encodeURIComponent(query);
  var result = apiGet(url, token);
  var projects = (result.ok ? result.data.projects : []) || [];

  var card = CardService.newCardBuilder()
    .setName('manageProjects')
    .setHeader(CardService.newCardHeader()
      .setTitle('Diract')
      .setSubtitle('Labelled projects (' + projects.length + ')'));

  card.addSection(CardService.newCardSection()
    .addWidget(CardService.newTextInput()
      .setFieldName('filterQuery').setTitle('Filter').setValue(query))
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('Search')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onFilterProjects')
          .setParameters({ accessToken: token, companyId: companyId })))));

  if (!result.ok) {
    card.addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph()
        .setText('⚠️ Error: ' + (result.data.error || 'Unknown'))));
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().pushCard(card.build()))
      .build();
  }

  if (!projects.length) {
    card.addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph()
        .setText(query ? 'No projects found for "' + query + '"' : 'No labelled projects found.')));
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().pushCard(card.build()))
      .build();
  }

  var selection = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.CHECK_BOX)
    .setFieldName('selectedProjects').setTitle('');

  for (var pi = 0; pi < projects.length; pi++) {
    var p = projects[pi];
    selection.addItem(p.name + (p.labelName ? '\n' + p.labelName : ''), p.id, false);
  }

  card.addSection(CardService.newCardSection()
    .setHeader('Select to delete')
    .addWidget(selection)
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('Delete selected')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setBackgroundColor('#dc2626')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('onDeleteSelected')
          .setParameters({ accessToken: token, companyId: companyId })))));

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(card.build()))
    .build();
}

function onDeleteSelected(e) {
  var selectedIds = e.formInputs.selectedProjects || [];
  var token = e.parameters.accessToken || getToken();
  var companyId = e.parameters.companyId || '';
  if (!selectedIds.length) return errorNotification('No projects selected');
  var deleted = 0;
  var errors = [];
  for (var i = 0; i < selectedIds.length; i++) {
    var result = apiPost('/remove-project', { projectId: selectedIds[i], companyId: companyId }, token);
    if (result.ok && result.data.ok) { deleted++; }
    else { errors.push(result.data.error || 'Unknown'); }
  }
  var msg = '✓ Deleted ' + deleted + ' project(s)';
  if (errors.length) msg += '. Errors: ' + errors.join(', ');
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification()
      .setText(msg)
      .setType(errors.length ? CardService.NotificationType.WARNING : CardService.NotificationType.INFO))
    .setNavigation(CardService.newNavigation().popCard())
    .build();
}

// ── Create project ─────────────────────────────────────────────────

function onCreateProject(e) {
  var formInputs = e.formInputs;
  var params = e.parameters;
  var projectName = ((formInputs.projectName || [''])[0] || '').trim();
  var matterNumber = ((formInputs.matterNumber || [''])[0] || '').trim();
  var status = (formInputs.status || ['active'])[0];
  var messageId = params.messageId || '';
  var token = params.accessToken || getToken();
  var companyId = params.companyId || '';
  if (!projectName) return errorNotification('Project name is required');
  var result = apiPost('/create-project', {
    projectName: projectName,
    matterNumber: matterNumber,
    status: status,
    messageId: messageId,
    companyId: companyId,
  }, token);

  if (!result.ok || !result.data.ok) {
    var errMsg = result.data.error || 'Unknown error';
    // Show constraint violations prominently
    if (result.code === 409) {
      return errorNotification('⚠ Cannot create project: ' + errMsg);
    }
    return errorNotification('Error: ' + errMsg);
  }
  var labelName = result.data.labelName;
  if (labelName) {
    createGmailLabel(token, labelName);
    if (messageId) {
      var labelId = getGmailLabelId(token, labelName);
      if (labelId) {
        UrlFetchApp.fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + messageId + '/modify',
          {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            payload: JSON.stringify({ addLabelIds: [labelId] }),
            muteHttpExceptions: true,
          }
        );
      }
    }
  }
  return successNotification('✓ Project "' + projectName + '" created — label applied.');
}

// ── Remove project / label ─────────────────────────────────────────

function onRemoveProject(e) {
  var params = e.parameters;
  var token = params.accessToken || getToken();
  var result = apiPost('/remove-project', {
    projectId: params.projectId,
    messageId: params.messageId || '',
  }, token);
  if (!result.ok || !result.data.ok) return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  return successNotification('✓ Project "' + params.projectName + '" removed');
}

function onRemoveLabel(e) {
  var params = e.parameters;
  var token = params.accessToken || getToken();
  var result = apiPost('/remove-label', { messageId: params.messageId }, token);
  if (!result.ok || !result.data.ok) return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  return successNotification('✓ Label removed');
}

// Always submits for admin approval — never archives directly, regardless
// of who clicks it. An admin approves/rejects from the admin "Gmail sync" tab.
function onRequestArchive(e) {
  var params = e.parameters;
  var token = params.accessToken || getToken();
  var result = apiPost('/request-archive', {
    projectId: params.projectId,
    companyId: params.companyId,
  }, token);
  if (!result.ok || !result.data.ok) return errorNotification('Error: ' + (result.data.error || 'Unknown'));
  if (result.data.alreadyRequested) return successNotification('Already requested — awaiting admin approval');
  return successNotification('✓ Archive requested for "' + params.projectName + '" — awaiting admin approval');
}

// ── Addon config — display fields ──────────────────────────────────

function onShowAddonConfig(e) {
  var token = e.parameters.accessToken || getToken();
  var companyId = e.parameters.companyId || '';
  var currentFields = (e.parameters.currentFields || '').split(',').filter(function(f) { return f; });
  var result = apiGet('/addon-config?companyId=' + companyId, token);
  if (!result.ok) return errorNotification('Could not load config');
  var current = currentFields.length ? currentFields : (result.data.displayFields || []);
  var available = result.data.availableFields || [];

  var card = CardService.newCardBuilder()
    .setName('addonConfig')
    .setHeader(CardService.newCardHeader().setTitle('Diract').setSubtitle('Configure display fields'));

  var section = CardService.newCardSection()
    .setHeader('Configure display order (up to 4 fields)')
    .addWidget(CardService.newTextParagraph()
      .setText('First field = main line, rest = subtitle. Use ↑↓ to reorder.'));

  if (!current.length) {
    section.addWidget(CardService.newTextParagraph().setText('No fields selected.'));
  }

  for (var ci = 0; ci < current.length; ci++) {
    var fieldKey = current[ci];
    var fieldLabel = fieldKey;
    for (var ai = 0; ai < available.length; ai++) {
      if (available[ai].key === fieldKey) { fieldLabel = available[ai].label; break; }
    }
    section.addWidget(CardService.newDecoratedText()
      .setText(fieldLabel).setTopLabel('Field ' + (ci + 1)));
    var btnSet = CardService.newButtonSet();
    if (ci > 0) {
      var upFields = current.slice();
      var tmp = upFields[ci - 1]; upFields[ci - 1] = upFields[ci]; upFields[ci] = tmp;
      btnSet.addButton(CardService.newTextButton().setText('↑')
        .setOnClickAction(CardService.newAction().setFunctionName('onShowAddonConfig')
          .setParameters({ accessToken: token, companyId: companyId, currentFields: upFields.join(',') })));
    }
    if (ci < current.length - 1) {
      var downFields = current.slice();
      var tmp2 = downFields[ci + 1]; downFields[ci + 1] = downFields[ci]; downFields[ci] = tmp2;
      btnSet.addButton(CardService.newTextButton().setText('↓')
        .setOnClickAction(CardService.newAction().setFunctionName('onShowAddonConfig')
          .setParameters({ accessToken: token, companyId: companyId, currentFields: downFields.join(',') })));
    }
    var removeFields = [];
    for (var ri = 0; ri < current.length; ri++) { if (ri !== ci) removeFields.push(current[ri]); }
    btnSet.addButton(CardService.newTextButton().setText('✕')
      .setOnClickAction(CardService.newAction().setFunctionName('onShowAddonConfig')
        .setParameters({ accessToken: token, companyId: companyId, currentFields: removeFields.join(',') })));
    section.addWidget(btnSet);
  }

  if (current.length < 4) {
    var addSelect = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('addField').setTitle('Add field');
    addSelect.addItem('— Select field —', '', true);
    for (var ai2 = 0; ai2 < available.length; ai2++) {
      var inCurrent = false;
      for (var ci2 = 0; ci2 < current.length; ci2++) {
        if (current[ci2] === available[ai2].key) { inCurrent = true; break; }
      }
      if (!inCurrent) addSelect.addItem(available[ai2].label, available[ai2].key, false);
    }
    section.addWidget(addSelect);
    section.addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton().setText('Add')
        .setOnClickAction(CardService.newAction().setFunctionName('onAddAddonField')
          .setParameters({ accessToken: token, companyId: companyId, currentFields: current.join(',') }))));
  }

  section.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton().setText('Save order')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setBackgroundColor('#4f46e5')
      .setOnClickAction(CardService.newAction().setFunctionName('onSaveAddonConfig')
        .setParameters({ accessToken: token, companyId: companyId, currentFields: current.join(',') }))));

  card.addSection(section);

  // Sort section
  var currentSortField = result.data.sortField || '__name__';
  var currentSortDir = result.data.sortDirection || 'asc';
  var sortSection = CardService.newCardSection().setHeader('Sort order');
  var sortFieldSelect = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName('sortField').setTitle('Sort by');
  sortFieldSelect.addItem('Project name', '__name__', currentSortField === '__name__');
  sortFieldSelect.addItem('Status', 'status', currentSortField === 'status');
  for (var ai3 = 0; ai3 < available.length; ai3++) {
    if (available[ai3].key !== '__name__' && available[ai3].key !== 'status') {
      sortFieldSelect.addItem(available[ai3].label, available[ai3].key, currentSortField === available[ai3].key);
    }
  }
  sortSection.addWidget(sortFieldSelect)
    .addWidget(CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('sortDirection').setTitle('Direction')
      .addItem('A → Z', 'asc', currentSortDir === 'asc')
      .addItem('Z → A', 'desc', currentSortDir === 'desc'))
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton().setText('Save sort')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setBackgroundColor('#4f46e5')
        .setOnClickAction(CardService.newAction().setFunctionName('onSaveAddonSort')
          .setParameters({ accessToken: token, companyId: companyId, currentFields: current.join(',') }))));
  card.addSection(sortSection);

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(card.build()))
    .build();
}

function onAddAddonField(e) {
  var token = e.parameters.accessToken || getToken();
  var companyId = e.parameters.companyId || '';
  var current = (e.parameters.currentFields || '').split(',').filter(function(f) { return f; });
  var addField = ((e.formInputs.addField || [''])[0] || '').trim();
  if (addField && current.length < 4) {
    var already = false;
    for (var i = 0; i < current.length; i++) { if (current[i] === addField) { already = true; break; } }
    if (!already) current.push(addField);
  }
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(
      (function() {
        var r = apiGet('/addon-config?companyId=' + companyId, token);
        var av = r.ok ? (r.data.availableFields || []) : [];
        var c2 = CardService.newCardBuilder().setName('addonConfig')
          .setHeader(CardService.newCardHeader().setTitle('Diract').setSubtitle('Configure display fields'));
        var s2 = CardService.newCardSection().setHeader('Fields updated');
        for (var i2 = 0; i2 < current.length; i2++) {
          var lbl = current[i2];
          for (var j = 0; j < av.length; j++) { if (av[j].key === current[i2]) { lbl = av[j].label; break; } }
          s2.addWidget(CardService.newDecoratedText().setText(lbl).setTopLabel('Field ' + (i2 + 1)));
        }
        s2.addWidget(CardService.newButtonSet()
          .addButton(CardService.newTextButton().setText('Save order')
            .setTextButtonStyle(CardService.TextButtonStyle.FILLED).setBackgroundColor('#4f46e5')
            .setOnClickAction(CardService.newAction().setFunctionName('onSaveAddonConfig')
              .setParameters({ accessToken: token, companyId: companyId, currentFields: current.join(',') }))));
        c2.addSection(s2);
        return c2.build();
      })()
    ))
    .build();
}

function onSaveAddonConfig(e) {
  var token = e.parameters.accessToken || getToken();
  var companyId = e.parameters.companyId || '';
  var fields = (e.parameters.currentFields || '').split(',').filter(function(f) { return f; });
  var configRes = apiGet('/addon-config?companyId=' + companyId, token);
  var sortField = configRes.ok ? (configRes.data.sortField || '__name__') : '__name__';
  var sortDir = configRes.ok ? (configRes.data.sortDirection || 'asc') : 'asc';
  var result = apiPost('/addon-config', { companyId: companyId, displayFields: fields, sortField: sortField, sortDirection: sortDir }, token);
  if (!result.ok) return errorNotification('Failed to save');
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification()
      .setText('✓ Fields saved. Re-open "Browse projects" to see changes.')
      .setType(CardService.NotificationType.INFO))
    .setNavigation(CardService.newNavigation().popCard().popCard())
    .build();
}

function onSaveAddonSort(e) {
  var token = e.parameters.accessToken || getToken();
  var companyId = e.parameters.companyId || '';
  var sortField = ((e.formInputs.sortField || ['__name__'])[0] || '__name__');
  var sortDir = ((e.formInputs.sortDirection || ['asc'])[0] || 'asc');
  var configRes = apiGet('/addon-config?companyId=' + companyId, token);
  var existingFields = configRes.ok ? (configRes.data.displayFields || []) : [];
  var result = apiPost('/addon-config', { companyId: companyId, displayFields: existingFields, sortField: sortField, sortDirection: sortDir }, token);
  if (!result.ok) return errorNotification('Failed to save sort');
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification()
      .setText('✓ Sort saved. Re-open "Browse projects" to see changes.')
      .setType(CardService.NotificationType.INFO))
    .setNavigation(CardService.newNavigation().popCard().popCard())
    .build();
}

// ── Gmail helpers ──────────────────────────────────────────────────

function getGmailLabelId(token, labelName) {
  var res = UrlFetchApp.fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels',
    { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  var labels = JSON.parse(res.getContentText()).labels || [];
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].name === labelName) return labels[i].id;
  }
  return null;
}

function createGmailLabel(token, labelName) {
  var parts = labelName.split('/');
  var existingRes = UrlFetchApp.fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels',
    { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  var existing = JSON.parse(existingRes.getContentText()).labels || [];
  for (var i = 1; i <= parts.length; i++) {
    var partial = parts.slice(0, i).join('/');
    var found = false;
    for (var j = 0; j < existing.length; j++) {
      if (existing[j].name === partial) { found = true; break; }
    }
    if (found) continue;
    var createRes = UrlFetchApp.fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      payload: JSON.stringify({
        name: partial,
        labelListVisibility: 'labelShow',
        messageListVisibility: i === parts.length ? 'show' : 'hide',
      }),
      muteHttpExceptions: true,
    });
    var created = JSON.parse(createRes.getContentText());
    if (created.id) existing.push({ id: created.id, name: partial });
  }
}
