const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();
app.use(cors({ origin: 'https://thestudiorack.com' }));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'StudioRack payment server running' });
});

// Create a Stripe Payment Intent
// Called when photographer clicks "Reserve now"
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, studioName, bookingDate, hours } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe uses pence not pounds
      currency: 'gbp',
      description: `StudioRack booking — ${studioName} — ${bookingDate} — ${hours} hour(s)`,
      metadata: {
        studioName,
        bookingDate,
        hours: String(hours),
        platform: 'thestudiorack.com'
      }
    });

    res.json({ clientSecret: paymentIntent.client_secret });

  } catch (error) {
    console.error('Payment intent error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Confirm a booking after successful payment
app.post('/confirm-booking', async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status === 'succeeded') {
      res.json({ success: true, status: paymentIntent.status });
    } else {
      res.json({ success: false, status: paymentIntent.status });
    }

  } catch (error) {
    console.error('Confirm booking error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stripe webhook — handles payment events automatically
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || ''
    );
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      console.log('Payment succeeded:', event.data.object.id);
      break;
    case 'payment_intent.payment_failed':
      console.log('Payment failed:', event.data.object.id);
      break;
    default:
      console.log(`Unhandled event: ${event.type}`);
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`StudioRack payment server running on port ${PORT}`);
});
