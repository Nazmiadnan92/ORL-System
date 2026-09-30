-- Deliberately fabricated fixture; no production exports are used.
insert into public.orl_requests(id,request_number,patient_ic,mrn,patient_name,surgery,diagnosis,doctor,specialist,sub_specialty,phone)
values('99999999-9999-4999-8999-999999999999','SYNTHETIC-PRESERVE','000101000000','SYNTHETIC','Synthetic','TEST','TEST','Test','Test','Gen ORL','0');
create temp table prior_requests as select * from public.orl_requests;
create temp table prior_functions as select oid,prosrc,proacl,proconfig from pg_proc where pronamespace='public'::regnamespace;
