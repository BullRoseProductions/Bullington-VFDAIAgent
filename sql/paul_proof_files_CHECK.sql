-- READ-ONLY. Are Paul Stetzel's cert-proof files orphaned, or still behind his (kept) cert_submissions?
-- approve_cert_submission copies the SUBMISSION's proof_path onto the cert, so a deleted cert's file is usually the
-- same storage object his submission still points at. Expect: referenced_by_submission = files_in_folder (nothing orphaned).
WITH paul AS (SELECT id, department_id FROM public.members WHERE lower(btrim(name)) = 'paul stetzel'),
files AS (
  SELECT o.name FROM storage.objects o, paul p
   WHERE o.bucket_id = 'station-documents' AND o.name LIKE p.department_id::text || '/cert-proofs/' || p.id::text || '/%'
)
SELECT (SELECT count(*) FROM files) AS files_in_folder,
       (SELECT count(*) FROM files f WHERE EXISTS (SELECT 1 FROM public.cert_submissions cs WHERE cs.proof_path = f.name)) AS referenced_by_submission,
       (SELECT count(*) FROM files f WHERE NOT EXISTS (SELECT 1 FROM public.cert_submissions cs WHERE cs.proof_path = f.name)) AS orphaned,
       (SELECT count(*) FROM public.cert_submissions cs JOIN paul p ON p.id = cs.member_id WHERE cs.proof_path IS NOT NULL) AS submissions_with_proof;
