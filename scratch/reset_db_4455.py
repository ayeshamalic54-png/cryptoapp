import os
import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import database
import datetime

conn = database.get_connection()
cur = conn.cursor()

# Reset bot_state to the current MT5 login (108605637) and balance (4455.80)
cur.execute("""
    UPDATE bot_state 
    SET initial_balance = 4455.80, 
        equity = 4455.80, 
        max_equity_peak = 4455.80, 
        mt5_login = 108605637, 
        overall_drawdown = 0.00 
    WHERE id = 1
""")

# Reset daily_metrics for today (2026-07-18)
today = datetime.date(2026, 7, 18)
cur.execute("""
    UPDATE daily_metrics 
    SET start_equity = 4455.80, 
        current_equity = 4455.80, 
        max_drawdown_percent = 0.00 
    WHERE trading_date = %s
""", (today,))

conn.commit()
cur.close()
conn.close()
print("Database successfully reset to 4455.80 balance and login 108605637!")
