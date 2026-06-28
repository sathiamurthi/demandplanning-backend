// handlers/registerTenant.handler.ts
import { query, queryOne, withTransaction } from "../../config/db";
import { ICommandHandler } from "../../cqrs/commandBus";
import { RegisterTenantCommand } from "./registertenant.command";
import bcrypt from "bcryptjs";
import slugify from "slugify";
import { sendWelcomeEmail } from "../../utils/email";
import { sendRegistrationWhatsApp } from "../../utils/whatsapp";

export class RegisterTenantCommandHandler implements ICommandHandler<RegisterTenantCommand, any> {
  async execute(command: RegisterTenantCommand) {
    const { firstName, lastName, industry_id, companyName, email, phone, password } = command.payload;

    const emailNorm = email ? email.toLowerCase().trim() : null;
    const phoneNorm = phone ? phone.trim() : null;

    if (!emailNorm && !phoneNorm) throw new Error('Email or phone number is required');

    if (emailNorm) {
      const existing = await queryOne<any>(`SELECT id FROM users WHERE email=$1`, [emailNorm]);
      if (existing) throw new Error('Email already registered. Please log in or use a different email.');
    }
    if (phoneNorm) {
      const existing = await queryOne<any>(
        `SELECT id FROM users WHERE phone=$1 AND phone IS NOT NULL AND phone<>''`,
        [phoneNorm]
      );
      if (existing) throw new Error('Phone number already registered. Please log in or use a different number.');
    }

    const hashed = await bcrypt.hash(password, 10);

    const slugBase = companyName || emailNorm?.split('@')[0] || phoneNorm || 'business';
    const baseSlug = slugify(slugBase, { lower: true, strict: true });
    let slug = baseSlug;
    let attempt = 0;
    while (true) {
      const taken = await queryOne<any>(`SELECT id FROM tenants WHERE slug=$1`, [slug]);
      if (!taken) break;
      attempt++;
      slug = `${baseSlug}-${attempt}`;
    }

    const industryConfig = await queryOne<any>(
      `SELECT id FROM industry_configs WHERE industry_id=$1 OR id::text=$1 LIMIT 1`,
      [industry_id]
    );

    const resolvedEmail = emailNorm || `user_${Date.now()}@noemail.local`;
    const regType = phoneNorm && !emailNorm ? 'phone' : 'email';

    return withTransaction(async (client) => {
      const tenantRes = await client.query(
        `INSERT INTO tenants (name, plan_type, billing_status, slug, is_active, created_at)
         VALUES ($1, 'free', 'active', $2, TRUE, NOW())
         RETURNING id, name, plan_type, slug`,
        [companyName, slug]
      );
      const tenant = tenantRes.rows[0];

      if (industryConfig) {
        await client.query(
          `INSERT INTO tenant_industries (tenant_id, industry_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [tenant.id, industryConfig.id]
        );
      }

      const storeRes = await client.query(
        `INSERT INTO stores (tenant_id, name, code, is_active, created_at)
         VALUES ($1, $2, $3, TRUE, NOW())
         RETURNING id`,
        [tenant.id, companyName, slug.substring(0, 10).toUpperCase()]
      );
      const store = storeRes.rows[0];

      const userRes = await client.query(
        `INSERT INTO users (tenant_id, store_id, email, phone, password_hash, role, first_name, last_name, is_active, is_email_verified, reg_type)
         VALUES ($1, $2, $3, $4, $5, 'owner', $6, $7, TRUE, FALSE, $8)
         RETURNING id, email, phone, role, tenant_id, store_id, first_name, last_name`,
        [tenant.id, store.id, resolvedEmail, phoneNorm, hashed, firstName || '', lastName || '', regType]
      );
      const user = userRes.rows[0];

      const resolvedIndustry = (industry_id || "").toLowerCase();
      let industryKey = "retail";
      if (resolvedIndustry.includes("pharma")) industryKey = "pharma";
      else if (resolvedIndustry.includes("grocery") || resolvedIndustry.includes("kirana")) industryKey = "grocery";
      else if (resolvedIndustry.includes("auto") || resolvedIndustry.includes("parts")) industryKey = "auto";

      const categoriesMap: Record<string, Array<{ name: string, code: string, desc: string }>> = {
        pharma: [
          { name: "Cardiac Medicines", code: "CARDIAC", desc: "Cardiovascular drugs and treatments" },
          { name: "Diabetes Care", code: "DIABETES", desc: "Insulin and blood glucose control" },
          { name: "Surgical Supplies", code: "SURGICAL", desc: "Bandages, gloves, syringes, surgical tools" },
          { name: "Vitamins & Supplements", code: "VITAMINS", desc: "Multivitamins, calcium, immune boosters" }
        ],
        grocery: [
          { name: "Vegetables & Fruits", code: "PRODUCE", desc: "Fresh fruits and green vegetables" },
          { name: "Dairy & Eggs", code: "DAIRY", desc: "Milk, cheese, butter, eggs" },
          { name: "Grains & Pulses", code: "GRAINS", desc: "Rice, wheat, flour, lentils" },
          { name: "Beverages", code: "BEVERAGES", desc: "Soft drinks, juices, tea, coffee" }
        ],
        auto: [
          { name: "Engine Parts", code: "ENGINE", desc: "Spark plugs, pistons, filters, engine belts" },
          { name: "Electrical", code: "ELECTRICAL", desc: "Batteries, car bulbs, fuses, sensors" },
          { name: "Body & Exterior", code: "BODY", desc: "Mirrors, wipers, bumpers, panels" },
          { name: "Tyres & Wheels", code: "TYRES", desc: "Car and motorcycle tyres, tubes, rims" }
        ]
      };

      const defaultCategories = categoriesMap[industryKey] || [
        { name: "General", code: "GENERAL", desc: "Default category" }
      ];

      for (let i = 0; i < defaultCategories.length; i++) {
        const cat = defaultCategories[i];
        await client.query(
          `INSERT INTO categories (tenant_id, name, code, description, sort_order)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, name) DO NOTHING`,
          [tenant.id, cat.name, cat.code, cat.desc, i]
        );
      }

      const result = {
        tenant,
        store,
        user: { ...user, password_hash: undefined },
        industryLinked: !!industryConfig,
      };

      if (emailNorm) {
        sendWelcomeEmail(emailNorm, firstName || '', companyName).catch((e: Error) =>
          console.warn('[email] Welcome email failed:', e.message)
        );
      }

      if (phoneNorm) {
        sendRegistrationWhatsApp(phoneNorm, firstName || '', companyName, tenant.plan_type).catch((e: Error) =>
          console.warn('[whatsapp] Registration message failed:', e.message)
        );
      }

      return result;
    });
  }
}
