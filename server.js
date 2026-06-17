const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = 'StudioRack <bookings@thestudiorack.com>';

// Admin Supabase client — can look up owner emails securely
const sbAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const app = express();
app.use(cors({ origin: 'https://thestudiorack.com' }));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'StudioRack payment server running' });
});

// ── Email templates ──
function bookingConfirmationEmail({ studioName, bookingDate, startTime, hours, total }) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
    <h1 style="font-size:22px;color:#0a0a0a;">Your booking is confirmed</h1>
    <p style="color:#555;line-height:1.6;">Thanks for booking with StudioRack. Here are your details:</p>
    <div style="background:#f7f5f2;border-radius:12px;padding:20px;margin:20px 0;">
      <p style="margin:6px 0;"><strong>Studio:</strong> ${studioName}</p>
      <p style="margin:6px 0;"><strong>Date:</strong> ${bookingDate}</p>
      <p style="margin:6px 0;"><strong>Start time:</strong> ${startTime}</p>
      <p style="margin:6px 0;"><strong>Duration:</strong> ${hours} hour(s)</p>
      <p style="margin:6px 0;"><strong>Total paid:</strong> &pound;${total}</p>
    </div>
    <p style="color:#555;line-height:1.6;">Just turn up at your booked time and create. If you have any questions, reply to this email.</p>
    <p style="color:#999;font-size:12px;margin-top:32px;">StudioRack &middot; thestudiorack.com</p>
  </div>`;
}

function hostBookingAlertEmail({ studioName, bookingDate, startTime, hours, total, ownerPayout }) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
    <h1 style="font-size:22px;color:#0a0a0a;">New booking request</h1>
    <p style="color:#555;line-height:1.6;">A photographer wants to book your studio on StudioRack. Please accept or decline it in your dashboard.</p>
    <div style="background:#f7f5f2;border-radius:12px;padding:20px;margin:20px 0;">
      <p style="margin:6px 0;"><strong>Studio:</strong> ${studioName}</p>
      <p style="margin:6px 0;"><strong>Date:</strong> ${bookingDate}</p>
      <p style="margin:6px 0;"><strong>Start time:</strong> ${startTime}</p>
      <p style="margin:6px 0;"><strong>Duration:</strong> ${hours} hour(s)</p>
      <p style="margin:6px 0;"><strong>Your earnings (90%) if you accept:</strong> &pound;${ownerPayout}</p>
    </div>
    <p style="color:#555;line-height:1.6;"><a href="https://thestudiorack.com/host.html" style="color:#0a0a0a;font-weight:600;">Open your dashboard</a> to accept or decline. Please respond promptly — the photographer is waiting and has already paid (they're refunded if you decline).</p>
    <p style="color:#999;font-size:12px;margin-top:32px;">StudioRack &middot; thestudiorack.com</p>
  </div>`;
}

function bookingDeclinedEmail({ studioName, bookingDate, startTime, hours }) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
    <h1 style="font-size:22px;color:#0a0a0a;">Your booking request couldn't be confirmed</h1>
    <p style="color:#555;line-height:1.6;">Unfortunately the studio owner wasn't able to confirm your request for <strong>${studioName}</strong> on ${bookingDate} at ${startTime} (${hours} hour(s)).</p>
    <p style="color:#555;line-height:1.6;">You'll be refunded in full. Feel free to browse other studios or try a different time.</p>
    <p style="color:#999;font-size:12px;margin-top:32px;">StudioRack &middot; thestudiorack.com</p>
  </div>`;
}

function bookingRequestReceivedEmail({ studioName, bookingDate, startTime, hours, total }) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
    <h1 style="font-size:22px;color:#0a0a0a;">Your booking request has been sent</h1>
    <p style="color:#555;line-height:1.6;">Thanks for booking with StudioRack. Your request has been sent to the studio owner to confirm — we'll email you the moment they accept.</p>
    <div style="background:#f7f5f2;border-radius:12px;padding:20px;margin:20px 0;">
      <p style="margin:6px 0;"><strong>Studio:</strong> ${studioName}</p>
      <p style="margin:6px 0;"><strong>Date:</strong> ${bookingDate}</p>
      <p style="margin:6px 0;"><strong>Start time:</strong> ${startTime}</p>
      <p style="margin:6px 0;"><strong>Duration:</strong> ${hours} hour(s)</p>
      <p style="margin:6px 0;"><strong>Total paid:</strong> &pound;${total}</p>
    </div>
    <p style="color:#555;line-height:1.6;">If the owner can't confirm your time, you'll be refunded in full. No action needed from you for now.</p>
    <p style="color:#999;font-size:12px;margin-top:32px;">StudioRack &middot; thestudiorack.com</p>
  </div>`;
}

// ── Send booking emails ──
app.post('/send-booking-emails', async (req, res) => {
  try {
    const { photographerEmail, studioId, studioName, bookingDate, startTime, hours, total } = req.body;
    const ownerPayout = Math.round((total || 0) * 0.9);
    const results = {};

    // "Request received" note to photographer (booking is pending until the owner accepts)
    if (photographerEmail) {
      const r = await resend.emails.send({
        from: FROM,
        to: photographerEmail,
        subject: `Booking request sent - ${studioName}`,
        html: bookingRequestReceivedEmail({ studioName, bookingDate, startTime, hours, total })
      });
      results.photographer = r.error ? r.error.message : 'sent';
    }

    // Look up the studio owner's email securely, then alert them
    if (studioId) {
      try {
        // Get the owner_id from the studio
        const { data: studio } = await sbAdmin
          .from('studios')
          .select('owner_id')
          .eq('id', studioId)
          .single();

        if (studio && studio.owner_id) {
          // Get the owner's email from the auth users table
          const { data: userData } = await sbAdmin.auth.admin.getUserById(studio.owner_id);
          const hostEmail = userData?.user?.email;

          if (hostEmail) {
            const r = await resend.emails.send({
              from: FROM,
              to: hostEmail,
              subject: `New booking request for ${studioName}`,
              html: hostBookingAlertEmail({ studioName, bookingDate, startTime, hours, total, ownerPayout })
            });
            results.host = r.error ? r.error.message : 'sent';
          }
        }
      } catch (lookupErr) {
        console.error('Host lookup error:', lookupErr);
        results.host = 'lookup failed';
      }
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Email send error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Email the photographer when a host accepts or declines their request
app.post('/booking-status-email', async (req, res) => {
  try {
    const { bookingId, status } = req.body;
    if (!bookingId || !status) return res.status(400).json({ error: 'Missing data' });

    const { data: booking } = await sbAdmin
      .from('bookings')
      .select('studio_id, photographer_id, booking_date, start_time, hours, total_price')
      .eq('id', bookingId)
      .single();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    let studioName = 'your studio';
    const { data: studio } = await sbAdmin.from('studios').select('name').eq('id', booking.studio_id).single();
    if (studio && studio.name) studioName = studio.name;

    const { data: userData } = await sbAdmin.auth.admin.getUserById(booking.photographer_id);
    const email = userData?.user?.email;
    if (!email) return res.status(404).json({ error: 'Photographer email not found' });

    const details = {
      studioName,
      bookingDate: booking.booking_date,
      startTime: booking.start_time,
      hours: booking.hours,
      total: booking.total_price
    };

    if (status === 'confirmed') {
      await resend.emails.send({
        from: FROM,
        to: email,
        subject: `Booking confirmed - ${studioName}`,
        html: bookingConfirmationEmail(details)
      });
    } else if (status === 'declined') {
      await resend.emails.send({
        from: FROM,
        to: email,
        subject: `Booking request update - ${studioName}`,
        html: bookingDeclinedEmail(details)
      });
    }

    res.json({ sent: true });
  } catch (error) {
    console.error('Status email error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper: verify the caller is the studio owner for a given booking
async function verifyHostForBooking(token, bookingId) {
  const { data: userData } = await sbAdmin.auth.getUser(token);
  const hostId = userData?.user?.id;
  if (!hostId) return { error: 'Not signed in', code: 401 };
  const { data: booking } = await sbAdmin.from('bookings').select('*').eq('id', bookingId).single();
  if (!booking) return { error: 'Booking not found', code: 404 };
  const { data: studio } = await sbAdmin.from('studios').select('owner_id, name').eq('id', booking.studio_id).single();
  if (!studio || studio.owner_id !== hostId) return { error: 'Not your studio', code: 403 };
  return { booking, studioName: studio.name };
}

// Host accepts a booking — capture the held payment and confirm
app.post('/accept-booking', async (req, res) => {
  try {
    const { bookingId, token } = req.body;
    if (!bookingId || !token) return res.status(400).json({ error: 'Missing data' });
    const v = await verifyHostForBooking(token, bookingId);
    if (v.error) return res.status(v.code).json({ error: v.error });

    // Capture the authorised payment (charges the card now)
    try {
      await stripe.paymentIntents.capture(v.booking.stripe_payment_id);
    } catch (e) {
      return res.status(400).json({ error: 'Could not take payment: ' + e.message });
    }

    await sbAdmin.from('bookings').update({ status: 'confirmed', payment_status: 'paid' }).eq('id', bookingId);

    // Email the photographer
    const { data: userData } = await sbAdmin.auth.admin.getUserById(v.booking.photographer_id);
    const email = userData?.user?.email;
    if (email) {
      await resend.emails.send({
        from: FROM, to: email,
        subject: `Booking confirmed - ${v.studioName}`,
        html: bookingConfirmationEmail({
          studioName: v.studioName, bookingDate: v.booking.booking_date,
          startTime: v.booking.start_time, hours: v.booking.hours, total: v.booking.total_price
        })
      });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Accept booking error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Host declines a booking — release the held payment (no charge, no refund)
app.post('/decline-booking', async (req, res) => {
  try {
    const { bookingId, token } = req.body;
    if (!bookingId || !token) return res.status(400).json({ error: 'Missing data' });
    const v = await verifyHostForBooking(token, bookingId);
    if (v.error) return res.status(v.code).json({ error: v.error });

    // Cancel the authorisation (releases the hold — nothing is charged)
    try {
      await stripe.paymentIntents.cancel(v.booking.stripe_payment_id);
    } catch (e) {
      console.error('Cancel authorisation failed (continuing):', e.message);
    }

    await sbAdmin.from('bookings').update({ status: 'declined', payment_status: 'cancelled' }).eq('id', bookingId);

    const { data: userData } = await sbAdmin.auth.admin.getUserById(v.booking.photographer_id);
    const email = userData?.user?.email;
    if (email) {
      await resend.emails.send({
        from: FROM, to: email,
        subject: `Booking request update - ${v.studioName}`,
        html: bookingDeclinedEmail({
          studioName: v.studioName, bookingDate: v.booking.booking_date,
          startTime: v.booking.start_time, hours: v.booking.hours
        })
      });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Decline booking error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Parse a booking date + start time into a Date (handles "9:00 AM" and "09:00")
function bookingStartDate(dateStr, timeStr) {
  let h = 0, m = 0;
  const ampm = (timeStr || '').match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (ampm) { h = (parseInt(ampm[1], 10) % 12) + (/pm/i.test(ampm[3]) ? 12 : 0); m = parseInt(ampm[2], 10); }
  else { const t = (timeStr || '').match(/^(\d{1,2}):(\d{2})$/); if (t) { h = parseInt(t[1], 10); m = parseInt(t[2], 10); } }
  return new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
}

function bookingCancelledEmail({ studioName, bookingDate, startTime, refundText }) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
    <h1 style="font-size:22px;color:#0a0a0a;">Your booking has been cancelled</h1>
    <p style="color:#555;line-height:1.6;">Your booking for <strong>${studioName}</strong> on ${bookingDate} at ${startTime} has been cancelled.</p>
    <p style="color:#555;line-height:1.6;">${refundText}</p>
    <p style="color:#999;font-size:12px;margin-top:32px;">StudioRack &middot; thestudiorack.com</p>
  </div>`;
}

// Customer cancels their own booking — releases the hold or refunds per the cancellation policy, automatically
app.post('/cancel-booking', async (req, res) => {
  try {
    const { bookingId, token } = req.body;
    if (!bookingId || !token) return res.status(400).json({ error: 'Missing data' });

    const { data: userData } = await sbAdmin.auth.getUser(token);
    const uid = userData?.user?.id;
    if (!uid) return res.status(401).json({ error: 'Not signed in' });

    const { data: booking } = await sbAdmin.from('bookings').select('*').eq('id', bookingId).single();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.photographer_id !== uid) return res.status(403).json({ error: 'This is not your booking' });
    if (['cancelled', 'declined', 'refunded'].includes(booking.status)) {
      return res.json({ success: true, message: 'This booking is already cancelled.' });
    }

    const pi = booking.stripe_payment_id;
    let message = 'Your booking has been cancelled.';
    let newPaymentStatus = 'cancelled';

    if (booking.payment_status === 'authorized') {
      // Not charged yet — just release the hold
      try { if (pi) await stripe.paymentIntents.cancel(pi); } catch (e) { console.error('cancel auth:', e.message); }
      message = 'Your booking has been cancelled. Your card was only on hold and has not been charged.';
    } else if (booking.payment_status === 'paid') {
      // Already charged — refund per policy: >48h full, within 48h 50%, past start none
      const hoursUntil = (bookingStartDate(booking.booking_date, booking.start_time).getTime() - Date.now()) / 3600000;
      const totalPence = Math.round((booking.total_price || 0) * 100);
      let refundPence = 0;
      if (hoursUntil > 48) refundPence = totalPence;
      else if (hoursUntil > 0) refundPence = Math.round(totalPence * 0.5);
      else refundPence = 0;

      if (refundPence > 0) {
        try { await stripe.refunds.create({ payment_intent: pi, amount: refundPence }); }
        catch (e) { console.error('refund:', e.message); return res.status(400).json({ error: 'Refund failed: ' + e.message }); }
      }
      if (refundPence === totalPence) { newPaymentStatus = 'refunded'; message = 'Your booking has been cancelled and a full refund of £' + (refundPence / 100).toFixed(2) + ' is on its way (5–10 business days).'; }
      else if (refundPence > 0)      { newPaymentStatus = 'partially_refunded'; message = 'Your booking has been cancelled. As it was within 48 hours, a 50% refund of £' + (refundPence / 100).toFixed(2) + ' is on its way (5–10 business days).'; }
      else                           { newPaymentStatus = 'cancelled'; message = 'Your booking has been cancelled. As it was after the start time, no refund is due under the cancellation policy.'; }
    }

    await sbAdmin.from('bookings').update({ status: 'cancelled', payment_status: newPaymentStatus }).eq('id', bookingId);

    // Notify the customer
    try {
      const email = userData.user.email;
      let studioName = 'your studio';
      const { data: studio } = await sbAdmin.from('studios').select('name, owner_id').eq('id', booking.studio_id).single();
      if (studio && studio.name) studioName = studio.name;
      const refundText = booking.payment_status === 'paid'
        ? message
        : 'Your card was only on hold and was never charged, so there is nothing to refund.';
      if (email) {
        await resend.emails.send({ from: FROM, to: email, subject: `Booking cancelled - ${studioName}`, html: bookingCancelledEmail({ studioName, bookingDate: booking.booking_date, startTime: booking.start_time, refundText }) });
      }
      // Notify the host so they free up the slot
      if (studio && studio.owner_id) {
        const { data: hostData } = await sbAdmin.auth.admin.getUserById(studio.owner_id);
        const hostEmail = hostData?.user?.email;
        if (hostEmail) {
          await resend.emails.send({
            from: FROM, to: hostEmail,
            subject: `Booking cancelled - ${studioName}`,
            html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;"><h1 style="font-size:22px;">A booking was cancelled</h1><p style="color:#555;line-height:1.6;">The booking for <strong>${studioName}</strong> on ${booking.booking_date} at ${booking.start_time} (${booking.hours} hour(s)) has been cancelled by the photographer. This slot is now free again on StudioRack.</p><p style="color:#999;font-size:12px;margin-top:32px;">StudioRack &middot; thestudiorack.com</p></div>`
          });
        }
      }
    } catch (e) { console.error('cancel emails:', e.message); }

    res.json({ success: true, message });
  } catch (error) {
    console.error('Cancel booking error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Public availability for a studio (or studios) — powers the booking calendar.
// Uses the service role so it can see ALL bookings and host blocks (row-level security
// hides other people's bookings from each user), but returns ONLY the date/time/length —
// never names, emails, or who booked.
app.post('/availability', async (req, res) => {
  try {
    const { studioIds, from, to } = req.body || {};
    let q = sbAdmin.from('bookings')
      .select('studio_id, booking_date, start_time, hours')
      .in('status', ['pending', 'confirmed', 'blocked']);
    if (Array.isArray(studioIds) && studioIds.length) q = q.in('studio_id', studioIds);
    if (from) q = q.gte('booking_date', from);
    if (to)   q = q.lte('booking_date', to);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rows: data || [] });
  } catch (error) {
    console.error('Availability error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a Stripe Payment Intent
// Called when photographer clicks "Reserve now"
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, studioName, bookingDate, hours } = req.body;

    // amount is in POUNDS (e.g. 72 means £72). Stripe needs pence, converted below.
    if (!amount || amount < 1) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe uses pence not pounds
      currency: 'gbp',
      capture_method: 'manual', // authorise now, only charge when the host accepts
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

// Stripe webhook — keeps the database in sync with Stripe automatically
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || ''
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        await sbAdmin.from('bookings')
          .update({ payment_status: 'paid', status: 'confirmed' })
          .eq('stripe_payment_id', pi.id);
        console.log('Payment succeeded — booking marked paid:', pi.id);
        break;
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        await sbAdmin.from('bookings')
          .update({ payment_status: 'failed' })
          .eq('stripe_payment_id', pi.id);
        console.log('Payment failed:', pi.id);
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object;
        const piId = charge.payment_intent;
        const fullyRefunded = charge.amount_refunded >= charge.amount;
        await sbAdmin.from('bookings')
          .update({
            payment_status: fullyRefunded ? 'refunded' : 'partially_refunded',
            status: fullyRefunded ? 'cancelled' : 'confirmed'
          })
          .eq('stripe_payment_id', piId);
        console.log('Refund processed for payment:', piId);
        break;
      }
      default:
        console.log(`Unhandled event: ${event.type}`);
    }
  } catch (err) {
    // Log but still return 200 so Stripe doesn't retry endlessly on a transient DB issue
    console.error('Error handling webhook event:', err.message);
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`StudioRack payment server running on port ${PORT}`);
});
