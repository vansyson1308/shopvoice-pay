BEGIN;

INSERT INTO tenants (id, name, status, processing_mode)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'V2 Dev Tenant', 'active', 'v2')
ON CONFLICT (id) DO NOTHING;

INSERT INTO platform_users (id, platform_user_id, display_name, platform)
VALUES
  ('22222222-2222-2222-2222-222222222222', 'zalo_dev_user_001', 'Dev Owner', 'zalo')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tenant_users (id, tenant_id, user_id, role, status)
VALUES
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'owner', 'active')
ON CONFLICT (tenant_id, user_id) DO NOTHING;

COMMIT;
