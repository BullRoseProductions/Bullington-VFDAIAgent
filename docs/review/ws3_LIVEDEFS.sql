-- READ-ONLY (WS-3): what the cert-proof storage carve-out pins against. No writes; counts only.
SELECT jsonb_pretty(jsonb_build_object(
  'objects_owner', (SELECT relowner::regrole::text FROM pg_class WHERE oid = 'storage.objects'::regclass),
  'postgres_member_of_owner', pg_has_role('postgres', (SELECT relowner FROM pg_class WHERE oid = 'storage.objects'::regclass), 'MEMBER'),
  'current_user', current_user,
  'storage_policies', (SELECT jsonb_agg(jsonb_build_object('name', policyname, 'cmd', cmd, 'roles', array_to_string(roles, ','), 'qual', qual, 'check', with_check) ORDER BY policyname)
                         FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'),
  'other_storage_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename <> 'objects'),
  'md5', (SELECT jsonb_object_agg(p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid))) FROM pg_proc p
            WHERE p.oid IN ('public.is_leader()'::regprocedure, 'public.my_department_id()'::regprocedure, 'public.my_member_id()'::regprocedure,
                            'public.is_canmanage_ops()'::regprocedure, 'public.is_dept_admin()'::regprocedure, 'public.is_equipment_manager()'::regprocedure,
                            'storage.foldername(text)'::regprocedure)),
  'foldername_def', pg_get_functiondef('storage.foldername(text)'::regprocedure),
  'objects_by_kind', (SELECT jsonb_object_agg(k, n) FROM (SELECT coalesce((storage.foldername(name))[2], '(root)') k, count(*) n
                         FROM storage.objects WHERE bucket_id = 'station-documents' GROUP BY 1) x),
  'cert_proof_paths_wellformed', (SELECT jsonb_build_object('uuid_owner_segment', count(*) FILTER (WHERE (storage.foldername(name))[3] ~ '^[0-9a-f-]{36}$'), 'total', count(*)) FROM storage.objects
                                   WHERE bucket_id = 'station-documents' AND (storage.foldername(name))[2] = 'cert-proofs'),
  'cert_proof_owner_is_member', (SELECT count(*) FROM storage.objects o WHERE o.bucket_id = 'station-documents' AND (storage.foldername(o.name))[2] = 'cert-proofs'
                                   AND EXISTS (SELECT 1 FROM public.members m WHERE m.id::text = (storage.foldername(o.name))[3] AND m.department_id::text = (storage.foldername(o.name))[1])),
  'certs_with_proof', (SELECT count(*) FROM public.certs WHERE proof_path IS NOT NULL),
  'certs_proof_not_under_cert_proofs', (SELECT count(*) FROM public.certs WHERE proof_path IS NOT NULL AND split_part(proof_path, '/', 2) <> 'cert-proofs'),
  'submissions_proof_not_under_cert_proofs', (SELECT count(*) FROM public.cert_submissions WHERE proof_path IS NOT NULL AND split_part(proof_path, '/', 2) <> 'cert-proofs'),
  'verified_presence', (SELECT count(*) FROM public.station_presence WHERE verified),
  'total_storage_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage')
)) AS r;
