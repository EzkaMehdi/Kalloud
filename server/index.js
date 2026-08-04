require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
app.use(cors()); app.use(express.json());

async function activeBusinessDay(client=pool) {
  const { rows } = await client.query("SELECT * FROM business_days WHERE status='OPEN' ORDER BY id DESC LIMIT 1");
  return rows[0];
}

async function daySummary(client, dayId) {
  const { rows } = await client.query(`SELECT COALESCE(SUM(total_amount),0)::DECIMAL(10,2) AS revenue, COALESCE(SUM(cash_amount),0)::DECIMAL(10,2) AS cash_revenue, COALESCE(SUM(card_amount),0)::DECIMAL(10,2) AS card_revenue, COUNT(*)::INT AS orders_count, COALESCE(AVG(total_amount),0)::DECIMAL(10,2) AS average_basket FROM orders WHERE status='COMPLETED' AND business_day_id=$1`,[dayId]);
  return rows[0];
}

app.get('/api/business-day', async (_,res) => {
  const day=await activeBusinessDay(); if(!day)return res.status(404).json({error:'Aucune journée ouverte'}); res.json(day);
});
app.get('/api/business-day/summary', async (_,res) => {
  const day=await activeBusinessDay(); if(!day)return res.status(404).json({error:'Aucune journée ouverte'}); const summary=await daySummary(pool,day.id); res.json({day,summary});
});
app.post('/api/business-day/close', async (req,res) => {
  const client=await pool.connect();
  try { await client.query('BEGIN'); const day=await activeBusinessDay(client); if(!day)throw new Error('Aucune journée ouverte'); const summary=await daySummary(client,day.id); const calculated=Number(day.opening_cash)+Number(summary.cash_revenue); const closingCash=Number(req.body.closingCash ?? calculated); await client.query("UPDATE business_days SET status='CLOSED', closed_at=NOW(), closing_cash=$1 WHERE id=$2",[closingCash,day.id]); const next=(await client.query("INSERT INTO business_days(opening_cash,status) VALUES($1,'OPEN') RETURNING *",[Number(req.body.nextOpeningCash ?? closingCash)])).rows[0]; await client.query("INSERT INTO cash_movements(business_day_id,type,amount,reason) VALUES($1,'OPENING',$2,$3)",[next.id,next.opening_cash,'Fond de caisse — nouvelle journée']); await client.query('COMMIT'); res.json({closed:{...day,summary,closingCash},opened:next});
  } catch(error){await client.query('ROLLBACK');res.status(400).json({error:error.message});} finally {client.release();}
});

app.get('/api/products', async (_, res) => {
  const { rows } = await pool.query(`SELECT p.*, c.name category FROM products p LEFT JOIN categories c ON c.id=p.category_id ORDER BY p.name`);
  res.json(rows);
});
app.get('/api/categories', async (_, res) => res.json((await pool.query('SELECT * FROM categories ORDER BY name')).rows));
app.post('/api/products', async (req,res) => {
  const { categoryId, name, price, stockQuantity=0, alertThreshold=5 } = req.body;
  const { rows } = await pool.query('INSERT INTO products(category_id,name,price,stock_quantity,alert_threshold) VALUES($1,$2,$3,$4,$5) RETURNING *',[categoryId,name,price,stockQuantity,alertThreshold]);
  res.status(201).json(rows[0]);
});
app.patch('/api/products/:id', async (req,res) => {
  const { name, price, stockQuantity, alertThreshold, isActive } = req.body;
  const { rows } = await pool.query(`UPDATE products SET name=COALESCE($1,name), price=COALESCE($2,price), stock_quantity=COALESCE($3,stock_quantity), alert_threshold=COALESCE($4,alert_threshold), is_active=COALESCE($5,is_active) WHERE id=$6 RETURNING *`,[name,price,stockQuantity,alertThreshold,isActive,req.params.id]);
  if(!rows[0]) return res.status(404).json({error:'Produit introuvable'}); res.json(rows[0]);
});
app.patch('/api/products/:id/stock', async (req,res) => {
  const { quantity } = req.body;
  const { rows } = await pool.query('UPDATE products SET stock_quantity=$1 WHERE id=$2 RETURNING *',[quantity,req.params.id]);
  res.json(rows[0]);
});
app.get('/api/tables', async (_,res) => res.json((await pool.query('SELECT * FROM tables_salle ORDER BY id')).rows));
app.post('/api/tables', async (req,res) => { const { rows }=await pool.query('INSERT INTO tables_salle(name) VALUES($1) RETURNING *',[req.body.name]);res.status(201).json(rows[0]); });
app.patch('/api/tables/:id', async (req,res) => { const { rows }=await pool.query("UPDATE tables_salle SET name=COALESCE($1,name), status=COALESCE($2,status) WHERE id=$3 RETURNING *",[req.body.name,req.body.status,req.params.id]); if(!rows[0])return res.status(404).json({error:'Table introuvable'});res.json(rows[0]); });
app.get('/api/orders', async (_,res) => res.json((await pool.query("SELECT o.*, t.name AS table_name FROM orders o LEFT JOIN tables_salle t ON t.id=o.table_id ORDER BY o.created_at DESC")).rows));
app.post('/api/cash-movements', async (req,res) => {
  const { type, amount, reason } = req.body;
  const day=await activeBusinessDay(); if(!day)return res.status(400).json({error:'Ouvrez une journée avant un mouvement'});
  const { rows } = await pool.query('INSERT INTO cash_movements(business_day_id,type,amount,reason) VALUES($1,$2,$3,$4) RETURNING *',[day.id,type,amount,reason]);
  res.status(201).json(rows[0]);
});
app.get('/api/cash-movements', async (_, res) => {
  const { rows } = await pool.query('SELECT * FROM cash_movements ORDER BY created_at DESC LIMIT 100');
  res.json(rows);
});
app.get('/api/cash-summary', async (_, res) => {
  const day=await activeBusinessDay(); if(!day)return res.json({balance:'0.00'});
  const { rows } = await pool.query(`SELECT (COALESCE((SELECT SUM(CASE WHEN type IN ('OPENING','IN') THEN amount ELSE -amount END) FROM cash_movements WHERE business_day_id=$1), 0) + COALESCE((SELECT SUM(cash_amount) FROM orders WHERE status='COMPLETED' AND business_day_id=$1), 0))::DECIMAL(10,2) AS balance`,[day.id]);
  res.json(rows[0]);
});
app.get('/api/dashboard', async (req,res) => {
  const today=new Date(); const year=Number(req.query.year)||today.getFullYear(); const month=Number(req.query.month)||today.getMonth()+1; const period=req.query.period||'day';
  let from, to;
  if(period==='year'){from=new Date(year,0,1);to=new Date(year+1,0,1);} else if(period==='month'){from=new Date(year,month-1,1);to=new Date(year,month,1);} else {from=new Date(today.getFullYear(),today.getMonth(),today.getDate());to=new Date(today.getFullYear(),today.getMonth(),today.getDate()+1);}
  if(period==='day'){const day=await activeBusinessDay(); if(day){const rows=await daySummary(pool,day.id);return res.json(rows);}}
  const { rows } = await pool.query(`SELECT COALESCE(SUM(total_amount),0)::DECIMAL(10,2) AS revenue, COALESCE(SUM(cash_amount),0)::DECIMAL(10,2) AS cash_revenue, COALESCE(SUM(card_amount),0)::DECIMAL(10,2) AS card_revenue, COUNT(*)::INT AS orders_count, COALESCE(AVG(total_amount),0)::DECIMAL(10,2) AS average_basket FROM orders WHERE status='COMPLETED' AND closed_at >= $1 AND closed_at < $2`,[from,to]);
  res.json(rows[0]);
});
// Crée et encaisse une commande dans la même transaction. Une vente ne peut pas
// être comptée sans diminuer le stock et libérer sa table associée.
app.post('/api/checkout', async (req,res) => {
  const client=await pool.connect();
  try { const { tableId=null, items, paymentMethod='CARD', cashAmount=0, cardAmount=0 }=req.body;
    if(!Array.isArray(items)||!items.length) throw new Error('Ajoutez au moins un article');
    await client.query('BEGIN');
    let total=0;
    for(const item of items){ const product=(await client.query('SELECT id,price,stock_quantity FROM products WHERE id=$1 AND is_active=true FOR UPDATE',[item.productId])).rows[0]; if(!product)throw new Error('Produit introuvable'); if(product.stock_quantity<item.quantity)throw new Error('Stock insuffisant'); item.unitPrice=Number(product.price); total+=item.unitPrice*item.quantity; }
    const day=await activeBusinessDay(client); if(!day)throw new Error('Aucune journée de caisse ouverte');
    const order=(await client.query("INSERT INTO orders(table_id,business_day_id,status,payment_method,cash_amount,card_amount,total_amount,closed_at) VALUES($1,$2,'COMPLETED',$3,$4,$5,$6,NOW()) RETURNING *",[tableId,day.id,paymentMethod,cashAmount,cardAmount||total,total])).rows[0];
    for(const item of items){await client.query('INSERT INTO order_items(order_id,product_id,quantity,unit_price,notes) VALUES($1,$2,$3,$4,$5)',[order.id,item.productId,item.quantity,item.unitPrice,item.notes||null]);await client.query('UPDATE products SET stock_quantity=stock_quantity-$1 WHERE id=$2',[item.quantity,item.productId]);}
    if(tableId)await client.query("UPDATE tables_salle SET status='FREE' WHERE id=$1",[tableId]); await client.query('COMMIT');res.status(201).json({order,total});
  }catch(error){await client.query('ROLLBACK');res.status(400).json({error:error.message});}finally{client.release();}
});
// Finalise une vente de façon atomique : stock, commande et table restent cohérents.
app.post('/api/orders/:id/complete', async (req,res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { paymentMethod, cashAmount=0, cardAmount=0 } = req.body;
    const order = (await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
    if (!order || order.status !== 'PENDING') throw new Error('Commande introuvable ou déjà traitée');
    const items = (await client.query('SELECT product_id,quantity FROM order_items WHERE order_id=$1',[order.id])).rows;
    for (const item of items) {
      const changed = await client.query('UPDATE products SET stock_quantity=stock_quantity-$1 WHERE id=$2 AND stock_quantity >= $1 RETURNING id',[item.quantity,item.product_id]);
      if (!changed.rowCount) throw new Error('Stock insuffisant pour un article');
    }
    await client.query(`UPDATE orders SET status='COMPLETED', payment_method=$1, cash_amount=$2, card_amount=$3, closed_at=NOW() WHERE id=$4`,[paymentMethod,cashAmount,cardAmount,order.id]);
    if(order.table_id) await client.query("UPDATE tables_salle SET status='FREE' WHERE id=$1",[order.table_id]);
    await client.query('COMMIT'); res.json({ok:true});
  } catch (error) { await client.query('ROLLBACK'); res.status(400).json({error:error.message});
  } finally { client.release(); }
});
app.listen(process.env.PORT || 3001, () => console.log('API Kalloud :3001'));
