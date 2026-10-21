-- Reviewed production 016 formatting variant from read-only function metadata.
-- Code only: no environment configuration, credentials, or patient records.
-- The body is identical to canonical 016 after removing leading ASCII spaces.
create or replace function public.orl_db_export(p_session_token uuid,p_password text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare u public.orl_users%rowtype;
begin
  u:=public.orl_require_webmaster_password(p_session_token,p_password);
    insert into public.orl_audit_log(user_id,user_name,user_role,action,record_type,details)
      values(u.id,u.display_name,u.role,'DATABASE_BACKUP_EXPORTED','DATABASE','Encrypted portable backup exported');
        return jsonb_build_object(
            'format','ORLOMS_BACKUP','version',1,'exported_at',now(),'exported_by',u.display_name,
                'users',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'username',username,'display_name',display_name,'role',role)),'[]'::jsonb) from public.orl_users),
                    'settings',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_settings x),
                        'holidays',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_holidays x),
                            'ot_sessions',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_ot_sessions x),
                                'requests',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_requests x),
                                    'ot_slots',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_ot_slots x),
                                        'audit_log',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.orl_audit_log x)
                                          );
                                          end $$;
