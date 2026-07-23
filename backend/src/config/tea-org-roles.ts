// TeaFactory360 — Estate & Factory organizational role catalog.
// Mirrors the real-world tea estate/factory org chart (garden owner/GM ->
// estate manager / factory manager -> supervisors -> field/factory labor).
// Kept as a static, curated list (not a DB-editable table) for now —
// "core fields first": role/department/employment-type/reports-to, not
// yet the full statutory/wage-structure register.

export interface RoleOption { value: string; label: string; }

export const ESTATE_ROLES: RoleOption[] = [
  { value: 'estate_manager',        label: 'Estate Manager / Superintendent' },
  { value: 'assistant_manager',     label: 'Assistant Manager' },
  { value: 'field_officer',         label: 'Field Officer / Supervisor' },
  { value: 'sardar',                label: 'Sardar / Head Kangani / Mandal' },
  { value: 'plucker',               label: 'Tea Plucker / Harvester' },
  { value: 'pruning_worker',        label: 'Pruning Worker' },
  { value: 'spraying_worker',       label: 'Spraying / Plant Protection Worker' },
  { value: 'irrigation_staff',      label: 'Irrigation Staff' },
  { value: 'nursery_worker',        label: 'Nursery In-charge / Worker' },
  { value: 'welfare_officer',       label: 'Welfare Officer' },
  { value: 'estate_doctor',         label: 'Estate Doctor / Medical Staff' },
  { value: 'timekeeper',            label: 'Timekeeper / Clerk' },
  { value: 'weighment_clerk',       label: 'Weighment Clerk' },
  { value: 'driver',                label: 'Driver' },
  { value: 'mechanic',              label: 'Vehicle Mechanic / Garage Staff' },
  { value: 'security',              label: 'Security / Watchman' },
  { value: 'general_labor',         label: 'General Estate Labor' },
];

export const FACTORY_ROLES: RoleOption[] = [
  { value: 'factory_manager',        label: 'Factory Manager / Superintendent' },
  { value: 'assistant_factory_mgr',  label: 'Assistant Factory Manager' },
  { value: 'tea_maker',              label: 'Tea Maker / Head Tea Maker' },
  { value: 'withering_incharge',     label: 'Withering In-charge / Worker' },
  { value: 'rolling_operator',       label: 'Rolling / CTC Machine Operator' },
  { value: 'fermentation_incharge',  label: 'Fermentation / Oxidation In-charge' },
  { value: 'dryer_operator',         label: 'Dryer Operator' },
  { value: 'grading_supervisor',     label: 'Sorting / Grading Supervisor' },
  { value: 'grading_worker',         label: 'Sorting / Grading Worker' },
  { value: 'packing_supervisor',     label: 'Packing Supervisor' },
  { value: 'packing_staff',          label: 'Packing Staff' },
  { value: 'tea_taster',             label: 'Tea Taster / Quality Control Officer' },
  { value: 'chemist',                label: 'Chemist / Lab Technician' },
  { value: 'mechanical_engineer',    label: 'Mechanical Engineer / Fitter' },
  { value: 'electrician',            label: 'Electrician' },
  { value: 'boiler_operator',        label: 'Boiler Operator' },
  { value: 'godown_incharge',        label: 'Godown / Warehouse In-charge' },
  { value: 'dispatch_staff',         label: 'Dispatch / Logistics Staff' },
  { value: 'driver',                 label: 'Driver' },
  { value: 'security',               label: 'Security Staff' },
];

export const EMPLOYMENT_TYPES: RoleOption[] = [
  { value: 'permanent',  label: 'Permanent' },
  { value: 'temporary',  label: 'Temporary' },
  { value: 'casual',     label: 'Casual' },
  { value: 'badli',      label: 'Badli (substitute)' },
  { value: 'seasonal',   label: 'Seasonal' },
  { value: 'contract',   label: 'Contract' },
  { value: 'apprentice', label: 'Apprentice / Trainee' },
];

export function roleLabel(department: string, value: string): string {
  const list = department === 'factory' ? FACTORY_ROLES : ESTATE_ROLES;
  return list.find(r => r.value === value)?.label || value;
}
