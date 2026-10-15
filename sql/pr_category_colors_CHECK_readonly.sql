-- READ-ONLY. Which saved PR categories have no chosen colour (blank or the column default #54506B)?
-- Those are the ones that now show the Noir accent rotation (red, amber, green, blue, steel, gold) by sort order.
-- Every other category keeps its saved colour. Nothing here writes.
SELECT d.name AS department, pc.sort_order, pc.label, pc.color,
       (pc.color IS NULL OR upper(pc.color) = '#54506B') AS takes_fallback
FROM public.post_categories pc
JOIN public.departments d ON d.id = pc.department_id
ORDER BY d.name, pc.sort_order, pc.label;
