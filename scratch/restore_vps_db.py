import os
import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import database
import datetime

conn = database.get_connection()
cur = conn.cursor()

# Reset bot_state to the VPS account (5053167592) and balance (5840.00)
cur.execute("""
    UPDATE bot_state 
    SET initial_balance = 5840.00, 
        equity = 5840.00, 
        max_equity_peak = 5840.00, 
        mt5_login = 5053167592, 
        overall_drawdown = 0.00 
    WHERE id = 1
""")

# Reset daily_metrics for today (2026-07-18)
today = datetime.date(2026, 7, 18)
cur.execute("""
    UPDATE daily_metrics 
    SET start_equity = 5840.00, 
        current_equity = 5840.00, 
        max_drawdown_percent = 0.00 
    WHERE trading_date = %s
""", (today,))

conn.commit()
cur.close()
conn.close()
print("Database successfully restored to VPS state (5840.00 balance and login 5053167592)!")
