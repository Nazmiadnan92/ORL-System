// Read-only presentation of audit events. Never rewrite or enrich historical records.
(function (root) {
  'use strict';
  var labels = {
    LOGIN: 'Signed in', USER_CREATED: 'Account created', USER_UPDATED: 'Account updated', USER_DELETED: 'Account deleted',
    ACCOUNT_PASSWORD_CHANGED: 'Password changed', REQUIRED_PASSWORD_CHANGED: 'Password change completed', ACCOUNT_THEME_CHANGED: 'Theme changed',
    REQUEST_CREATED: 'Request created', REQUEST_CONFIRMED: 'Request confirmed', REQUEST_APPROVE: 'Request approved', REQUEST_REJECT: 'Request rejected',
    PATIENT_ASSIGNED_CONFIRMED: 'OT slot confirmed', OT_SLOT_RESERVED: 'OT slot reserved',
    SLOT_EDIT_CONFIRM: 'Patient details updated', SLOT_EDIT_POSTPONE: 'Patient details updated', SLOT_EDIT_CANCEL: 'Case cancelled',
    DUPLICATE_OVERRIDE: 'Duplicate request allowed', POSTPONE_COUNT_UPDATED: 'Postpone count updated', REQUEST_PERMANENTLY_DELETED: 'Request permanently deleted',
    STAFF_CANCELLATION_REQUESTED: 'Cancellation requested', DELETION_REQUESTED: 'Cancellation requested', DELETION_APPROVE: 'Cancellation approved', DELETION_REJECT: 'Cancellation rejected',
    OT_SLOT_CLEARED: 'Patient removed from slot', BOOKING_MOVE_REQUESTED: 'Date change requested', BOOKING_MOVE_REJECTED: 'Date change rejected',
    PATIENT_POSTPONED: 'OT postponed', OT_POSTPONED: 'OT postponed', PATIENT_REASSIGNED: 'OT moved earlier', OT_SLOT_REASSIGNED: 'Slot changed',
    OT_HOLD_PLACED: 'Case put on Hold', OT_HOLD_REMOVED: 'Hold removed', OT_HOLD_MOVED: 'Held case rescheduled', OT_MARKED_DONE: 'Marked as Done', OT_DONE_REVERSED: 'Done status undone',
    PAST_CASE_ADDED: 'Past case added', PAST_CASE_CORRECTED: 'Past case corrected', OT_SESSION_UPDATED: 'OT day updated', OT_SLOT_CLOSED: 'Slot closed', OT_SLOT_REOPENED: 'Slot reopened',
    OT_DAY_NOTE_ADDED: 'Day Note added', OT_DAY_NOTE_UPDATED: 'Day Note updated', OT_DAY_NOTE_REMOVED: 'Day Note removed',
    HOLIDAY_OVERRIDE_ACTIVATED: 'OT enabled on blocked day', HOLIDAY_SAVED: 'Holiday / blocked day saved', HOLIDAY_DELETED: 'Holiday / blocked day removed',
    HOLIDAYS_GENERATED: 'Holidays added', ALL_HOLIDAYS_CLEARED: 'All holiday entries removed', SETTINGS_UPDATED: 'System settings saved',
    IC_FULL_REVEAL: 'Full IC access approved', OT_LIST_FULL_IC_GENERATED: 'OT list export approved',
    IC_ENCRYPTED_CREATED: 'IC / Passport saved securely', IC_ENCRYPTED_UPDATED: 'IC / Passport updated',
    IC_SHADOW_CREATED: 'Encrypted identity copy created', IC_SHADOW_UPDATED: 'Identity details updated',
    IC_C2_BACKFILL_BATCH: 'Existing identity records encrypted', IC_C2_COMPLETED: 'Identity encryption verified', IC_C6_PLAINTEXT_REMOVED: 'Unencrypted IC values removed',
    MAINTENANCE_ON: 'Maintenance enabled', MAINTENANCE_OFF: 'Maintenance disabled',
    DATABASE_BACKUP_EXPORTED: 'Backup prepared', DATABASE_BACKUP_IMPORTED: 'Backup restored', DATABASE_REPAIR: 'Database repaired',
    DATABASE_PATIENT_REMOVAL: 'Request records permanently deleted', AUDIT_CLEANUP: 'Old audit records removed'
  };
  var own = function (obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); };
  var text = function (value) { return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; };
  var escape = function (value) { return text(value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function rawText(value) {
    if (value === null || value === undefined) return '';
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }
  function object(value) {
    try { var obj = typeof value === 'string' ? JSON.parse(value) : value; return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}; }
    catch (_) { return {}; }
  }
  function date(value) {
    var s = text(value), m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? m[3] + '-' + m[2] + '-' + m[1] : s;
  }
  function time(value) {
    var s = text(value), d = new Date(s);
    if (!s || isNaN(d.getTime())) return s || 'Not recorded';
    return d.toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur' });
  }
  function describe(row) {
    row = row || {};
    var action = text(row.action), raw = text(row.details), data = object(row.details);
    var activity = own(labels, action) ? labels[action] : 'Other activity';
    var summary = 'Recorded system activity. See Technical details.', note = '', match;
    var get = function (key) { return own(data, key) ? text(data[key]) : ''; };
    var suffix = function (label, value) { return value ? ' ' + label + ': ' + value : ''; };
    var ot = function () { return suffix('OT', date(get('ot_date'))); };
    var reason = function (value) { return suffix('Reason', value); };
    var route = function () { return get('from') && get('to') ? ': ' + date(get('from')) + ' → ' + date(get('to')) : ''; };
    switch (action) {
      case 'OT_DAY_NOTE_ADDED': case 'OT_DAY_NOTE_UPDATED': case 'OT_DAY_NOTE_REMOVED':
        summary = ({OT_DAY_NOTE_ADDED:'Added',OT_DAY_NOTE_UPDATED:'Updated',OT_DAY_NOTE_REMOVED:'Removed'})[action] + ' the reminder for this OT date.' + ot();
        note = 'Bookings are unchanged. Note history is kept in Technical details.'; break;
      case 'LOGIN': summary = /password change/i.test(raw) ? 'Signed in. Password change required.' : 'Signed in to the system.'; break;
      case 'USER_CREATED': case 'USER_UPDATED': case 'USER_DELETED':
        summary = ({USER_CREATED:'Created', USER_UPDATED:'Updated', USER_DELETED:'Deleted'})[action] + ' account.';
        match = /^(.+?) \((STAFF|ADMIN|WEBMASTER)\)(; password change required)?$/.exec(raw);
        if (match) summary = summary.slice(0,-1) + ': ' + match[1] + '. Role: ' + match[2] + '.' + (match[3] ? ' Password change required.' : '');
        break;
      case 'ACCOUNT_PASSWORD_CHANGED': summary = 'Changed own password.'; break;
      case 'REQUIRED_PASSWORD_CHANGED': summary = 'Completed the required password change.'; break;
      case 'ACCOUNT_THEME_CHANGED': summary = 'Changed account theme.'; match = /^Theme changed to (.+)$/.exec(raw); if (match) summary = 'Changed theme to ' + match[1] + '.'; break;
      case 'REQUEST_CREATED': summary = 'Created a new draft request.'; break;
      case 'REQUEST_CONFIRMED': summary = 'Confirmed the request. Ready to choose an OT slot.'; break;
      case 'REQUEST_APPROVE': case 'REQUEST_REJECT': summary = (action === 'REQUEST_APPROVE' ? 'Approved' : 'Rejected') + ' the request.' + suffix('Note', raw); break;
      case 'PATIENT_ASSIGNED_CONFIRMED': summary = 'Assigned the patient to a confirmed OT slot.'; break;
      case 'OT_SLOT_RESERVED': summary = 'Reserved an OT slot for the patient.'; break;
      case 'SLOT_EDIT_CONFIRM': case 'SLOT_EDIT_POSTPONE': summary = /Staff updated Surgery/.test(raw) ? 'Updated diagnosis and procedure.' : 'Updated patient details.'; break;
      case 'SLOT_EDIT_CANCEL': summary = 'Cancelled the case and released its OT slot.'; if (/record retained/.test(raw)) summary += ' The request record was kept.'; break;
      case 'DUPLICATE_OVERRIDE':
        summary = 'Allowed a new request despite an existing record.';
        match = /^Override of (.+?) \| Reason: ([\s\S]*)$/.exec(raw);
        if (match) summary += suffix('Existing request', match[1]) + reason(match[2]); break;
      case 'POSTPONE_COUNT_UPDATED':
        summary = 'Updated the postpone count.'; match = /^(?:Unscheduled manual count|Manual count): (\d+) to (\d+)$/.exec(raw);
        if (match) summary = 'Changed postpone count from ' + match[1] + ' to ' + match[2] + '.'; break;
      case 'REQUEST_PERMANENTLY_DELETED': summary = 'Permanently deleted the request.'; break;
      case 'STAFF_CANCELLATION_REQUESTED': case 'DELETION_REQUESTED': summary = 'Requested cancellation.' + reason(raw); break;
      case 'DELETION_APPROVE': summary = 'Approved cancellation. The request record was kept.' + reason(raw); break;
      case 'DELETION_REJECT': summary = 'Rejected the cancellation request.' + suffix('Original cancellation reason', raw); break;
      case 'OT_SLOT_CLEARED': summary = 'Removed the patient from the OT slot.'; break;
      case 'BOOKING_MOVE_REQUESTED': summary = 'Requested an OT date change' + route() + '.' + reason(get('reason')); break;
      case 'BOOKING_MOVE_REJECTED': summary = 'Rejected the OT date change request.'; break;
      case 'PATIENT_POSTPONED':
        summary = 'Postponed OT' + route() + '.' + reason(get('reason'));
        match = /^(\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4}) to (\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4}) \| ([\s\S]*)$/.exec(raw);
        if (match) summary = 'Postponed OT: ' + date(match[1]) + ' → ' + date(match[2]) + '.' + reason(match[3]); break;
      case 'OT_POSTPONED': summary = 'Postponed OT.' + reason(raw); break;
      case 'PATIENT_REASSIGNED': summary = 'Moved OT to an earlier date' + route() + '.' + reason(get('reason')); break;
      case 'OT_SLOT_REASSIGNED':
        summary = 'Changed the patient’s OT slot.';
        if (get('from_slot_label') && get('to_slot_label')) {
          var donePast = get('mode') === 'DONE_PAST_REASSIGN';
          var swapped = donePast && !!get('to_request_id');
          if (get('mode') === 'CLOSED_PAST_REASSIGN' || donePast) activity = swapped ? 'Past OT slots swapped' : 'Past OT slot changed';
          summary = (swapped ? 'Swapped patients between ' + get('from_slot_label') + ' and ' + get('to_slot_label') : 'Moved patient: ' + get('from_slot_label') + ' → ' + get('to_slot_label')) + '.' + ot();
          if (donePast && (get('from_request_status') === 'COMPLETED' || get('to_request_status') === 'COMPLETED')) summary += ' Existing Done status kept.';
        } else {
          match = /^((?:Main|Special) Slot \d+) (moved to|swapped with) ((?:Main|Special) Slot \d+)$/.exec(raw);
          if (match) { activity = match[2] === 'swapped with' ? 'Slots swapped' : activity; summary = match[2] === 'swapped with' ? 'Swapped patients between ' + match[1] + ' and ' + match[3] + '.' : 'Moved patient: ' + match[1] + ' → ' + match[3] + '.'; }
        } break;
      case 'OT_HOLD_PLACED': summary = 'Put the case on Hold. Slot kept.' + ot() + reason(get('reason')); break;
      case 'OT_HOLD_REMOVED': summary = 'Removed Hold from the case.' + ot() + reason(get('reason')); break;
      case 'OT_HOLD_MOVED': summary = 'Moved the case on Hold to a new slot.' + (data.postpone_increment === 1 ? ' Postpone count increased by 1.' : '') + reason(get('reason')); break;
      case 'OT_MARKED_DONE': summary = 'Marked the case as Done.' + ot() + reason(get('reason')); break;
      case 'OT_DONE_REVERSED': summary = 'Undid the Done status.'; if (get('previous_status') === 'COMPLETED' && get('new_status') === 'SCHEDULED') summary = 'Changed status from Done to Scheduled.'; summary += ot() + reason(get('reason')); break;
      case 'PAST_CASE_ADDED': case 'PAST_CASE_CORRECTED':
        summary = (action === 'PAST_CASE_ADDED' ? 'Added a case to past OT.' : 'Corrected a past case.') + ot();
        if (/^(MAIN|SPECIAL)$/.test(get('slot_type')) && /^\d+$/.test(get('slot_number'))) summary += suffix('Slot', (get('slot_type') === 'MAIN' ? 'Main' : 'Special') + ' Slot ' + get('slot_number'));
        summary += reason(get('reason')); break;
      case 'OT_SESSION_UPDATED':
        summary = 'Saved OT day settings.'; match = /^(ACTIVE|CANCELLED|CLOSED)\s*([\s\S]*)$/.exec(raw);
        if (match) summary += suffix('Status', match[1]) + suffix('Title', match[2]); break;
      case 'OT_SLOT_CLOSED': case 'OT_SLOT_REOPENED':
        summary = action === 'OT_SLOT_CLOSED' ? 'Closed the OT slot.' : 'Reopened the OT slot.';
        match = /^(MAIN|SPECIAL) Slot (\d+)$/i.exec(raw); if (match) summary += suffix('Slot', (match[1].toUpperCase() === 'MAIN' ? 'Main' : 'Special') + ' Slot ' + match[2]); break;
      case 'HOLIDAY_OVERRIDE_ACTIVATED': summary = 'Enabled OT on a holiday or blocked day.'; break;
      case 'HOLIDAY_SAVED': summary = 'Saved a holiday or blocked day.'; match = /^(\d{4}-\d{2}-\d{2}) ([\s\S]+)$/.exec(raw); if (match) summary = 'Saved ' + match[2] + ' on ' + date(match[1]) + '.'; break;
      case 'HOLIDAY_DELETED': summary = 'Removed a holiday or blocked-day entry.'; break;
      case 'HOLIDAYS_GENERATED':
        summary = 'Added holidays.'; match = /^(\d+) added; (\d+) existing date\(s\) kept;/.exec(raw);
        if (match) summary = 'Added ' + match[1] + ' holidays' + (/^\d{4}$/.test(text(row.record_id)) ? ' for ' + row.record_id : '') + '. Kept ' + match[2] + ' existing dates.'; break;
      case 'ALL_HOLIDAYS_CLEARED': summary = 'Permanently removed all holiday / blocked-day entries.'; match = /^(\d+) holiday\/block record/.exec(raw); if (match) summary = 'Permanently removed ' + match[1] + ' holiday / blocked-day entries.'; break;
      case 'SETTINGS_UPDATED':
        summary = 'Saved system settings.';
        var settings = {SYSTEM_NAME:'System name', START_YEAR:'Start year', END_YEAR:'End year', OT_DAYS:'OT days', MAIN_SLOTS:'Main slots', SPECIAL_SLOTS:'Special slots'};
        Object.keys(settings).forEach(function (key) {
          var value = get(key);
          if (key === 'OT_DAYS') {
            var days = Array.isArray(data[key]) ? data[key] : /^[0-6](?:\s*,\s*[0-6])*$/.test(value) ? value.split(',') : null;
            if (days) value = days.map(function (day) { return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][Number(day)] || ''; }).filter(Boolean).join(', ');
          }
          if (value) summary += suffix(settings[key], value);
        }); break;
      case 'IC_FULL_REVEAL':
        summary = 'Approved full IC access.'; match = /^Authorized full IC access\. Purpose: ([\s\S]*?)\. Display expiry: 60 seconds\.$/.exec(raw);
        if (match) summary = 'Approved full IC access for 60 seconds.' + suffix('Purpose', match[1]); break;
      case 'OT_LIST_FULL_IC_GENERATED':
        summary = 'Approved Excel OT list export with full IC.';
        match = /OT date: (\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})\. Patient count: (\d+)\./.exec(raw);
        if (match) summary = 'Approved Excel export for OT ' + date(match[1]) + '. Patients: ' + match[2] + '. Full IC included.';
        note = 'Download and printing completion are not recorded.'; break;
      case 'IC_ENCRYPTED_CREATED': case 'IC_SHADOW_CREATED':
        if (raw === 'Optional IC absent') { activity = 'No IC / Passport entered'; summary = 'No IC / Passport was entered.'; }
        else summary = action === 'IC_ENCRYPTED_CREATED' ? 'Saved IC / Passport securely. Displayed value remains masked.' : 'Created and verified an encrypted IC copy. Original value was kept.'; break;
      case 'IC_ENCRYPTED_UPDATED': summary = 'Updated IC / Passport securely. Displayed value remains masked.'; break;
      case 'IC_SHADOW_UPDATED': summary = 'Updated identity details. Original value was kept.'; break;
      case 'IC_C2_BACKFILL_BATCH': case 'IC_C2_COMPLETED':
        match = /Count: (\d+)\.?$/.exec(raw);
        summary = (action === 'IC_C2_BACKFILL_BATCH' ? 'Encrypted ' : 'Completed encryption and verification of ') + (match ? match[1] + ' ' : '') + 'existing identity records. Original values were kept at this stage.'; break;
      case 'IC_C6_PLAINTEXT_REMOVED': summary = 'Removed unencrypted IC values from operational records after verification.'; match = /Protected count: (\d+)\.?$/.exec(raw); if (match) summary += suffix('Protected records', match[1]); break;
      case 'MAINTENANCE_ON':
        if (data.previous_enabled === true) { activity = 'Maintenance updated'; summary = 'Updated maintenance settings. Admin and Staff access remains paused.'; }
        else summary = 'Enabled maintenance. Admin and Staff access paused.';
        summary += suffix('Notice', get('message')) + (get('expected_end') ? suffix('Expected end (MYT)', time(get('expected_end'))) : ''); break;
      case 'MAINTENANCE_OFF': summary = 'Disabled maintenance. Maintenance access restrictions removed.'; break;
      case 'DATABASE_BACKUP_EXPORTED': summary = 'Prepared backup data for export.'; note = 'Download completion is not confirmed by this record.'; break;
      case 'DATABASE_BACKUP_IMPORTED': summary = 'Restored data from backup.'; match = /^(\d+) requests and (\d+) slots restored$/.exec(raw); if (match) summary = 'Restored ' + match[1] + ' requests and ' + match[2] + ' OT slots from backup.'; break;
      case 'DATABASE_REPAIR': summary = 'Repaired database inconsistencies.'; match = /^(\d+) inconsistency record\(s\) repaired; Main slots compacted$/.exec(raw); if (match) summary = 'Fixed ' + match[1] + ' inconsistencies and reordered Main slots.'; break;
      case 'DATABASE_PATIENT_REMOVAL': summary = 'Permanently deleted patient request records.'; match = /^(\d+) patient request record/.exec(raw); if (match) summary = 'Permanently deleted ' + match[1] + ' patient request records.'; break;
      case 'AUDIT_CLEANUP': summary = 'Removed old audit records.'; match = /^(\d+) audit record\(s\) before ([\s\S]+) removed$/.exec(raw); if (match) summary = 'Removed ' + match[1] + ' audit records dated before ' + date(match[2]) + '.'; break;
    }
    return { activity: activity, summary: summary, note: note };
  }
  function technical(row) {
    var field = function (name, value) { return '<dt>' + name + '</dt><dd>' + escape(text(value) || 'Not recorded') + '</dd>'; };
    var original = rawText(row.details);
    return '<details class="audit-technical"><summary>Technical details</summary><dl>' +
      field('Original action', row.action) + field('Record type', row.record_type) + field('Record ID', row.record_id) + field('Original timestamp', row.occurred_at) +
      '</dl><div class="audit-original-label">Original details</div><pre>' + escape(original || 'Not recorded') + '</pre></details>';
  }
  function table(rows) {
    return '<div id="auditRows" class="table-wrap audit-table"><table><thead><tr><th>Date / Time (MYT)</th><th>User</th><th>Role</th><th>Activity</th><th>Details</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (row) {
        var view = describe(row);
        return '<tr><td>' + escape(time(row.occurred_at)) + '</td><td>' + escape(text(row.user_name) || 'Not recorded') + '</td><td>' + escape(text(row.user_role) || 'Not recorded') + '</td><td><strong>' + escape(view.activity) + '</strong></td><td><div class="audit-summary">' + escape(view.summary) + '</div>' + (view.note ? '<small class="audit-note">' + escape(view.note) + '</small>' : '') + technical(row) + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="empty">No matching audit records.</td></tr>') + '</tbody></table></div>';
  }
  root.OrlAuditDisplay = Object.freeze({ describe: describe, table: table });
})(typeof window !== 'undefined' ? window : globalThis);
