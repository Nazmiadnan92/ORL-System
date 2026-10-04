// Public Supabase browser connection. This is intentionally a publishable key,
// never a service_role key. Database tables remain protected by RLS.
window.ORL_CONFIG = {
  supabaseUrl: 'https://imrfmilqehcrvassuvuw.supabase.co',
  supabaseAnonKey: 'sb_publishable_BWSdmqSjtSqPm0uF8SmqxQ_TKWqUDyY',
  // C1 release gates passed before cache 025 was published. Set false first
  // during rollback, then disable the Edge gateway before investigation.
  icProtectionEnabled: true
};
