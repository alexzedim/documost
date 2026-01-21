// /ee/billing/services/billing.service.ts
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@wiki/db/types/kysely.types';
import { Workspace } from '@wiki/db/types/entity.types';
import Stripe from 'stripe';

@Injectable()
export class BillingService {
  private stripe: Stripe;

  constructor(@InjectKysely() private readonly db: KyselyDB) {
    if (process.env.STRIPE_SECRET_KEY) {
      this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
        apiVersion: '2025-02-24.acacia',
      });
    }
  }

  async getBillingInfo(workspaceId: string): Promise<any> {
    return this.db
      .selectFrom('billing')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async getBillingPlans(): Promise<any[]> {
    return [
      {
        name: 'Standard',
        description: 'For small teams',
        productId: 'prod_standard',
        monthlyId: 'price_standard_monthly',
        yearlyId: 'price_standard_yearly',
        currency: 'usd',
        price: {
          monthly: '10',
          yearly: '100',
        },
        features: ['Unlimited pages', 'Collaboration', 'Version history'],
        billingScheme: 'per_seat',
      },
      {
        name: 'Business',
        description: 'For larger organizations',
        productId: 'prod_business',
        monthlyId: 'price_business_monthly',
        yearlyId: 'price_business_yearly',
        currency: 'usd',
        price: {
          monthly: '20',
          yearly: '200',
        },
        features: ['Everything in Standard', 'SSO', 'Advanced permissions'],
        billingScheme: 'per_seat',
      },
    ];
  }

  async createCheckoutSession(
    priceId: string,
    workspace: Workspace,
  ): Promise<{ url: string }> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}/settings/billing?success=true`,
      cancel_url: `${process.env.APP_URL}/settings/billing?canceled=true`,
      customer_email: workspace.billingEmail,
      metadata: { workspaceId: workspace.id },
    });

    return { url: session.url };
  }

  async createPortalSession(workspace: Workspace): Promise<{ url: string }> {
    const billing = await this.getBillingInfo(workspace.id);

    const session = await this.stripe.billingPortal.sessions.create({
      customer: billing.stripeCustomerId,
      return_url: `${process.env.APP_URL}/settings/billing`,
    });

    return { url: session.url };
  }
}
