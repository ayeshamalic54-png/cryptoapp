import os

main_path = os.path.join(os.path.dirname(__file__), "..", "main.py")

with open(main_path, "r", encoding="utf-8") as f:
    content = f.read()

# Target block to replace in main.py loop
old_switch_block = """            current_login = int(acc_info.login)
            if active_login_id is not None and active_login_id != current_login:
                logger.info(f"Account switch detected: {active_login_id} -> {current_login}. Resetting metrics database records.")
                from database import reset_database_metrics_for_new_account
                reset_database_metrics_for_new_account(current_login, acc_info.equity)
            active_login_id = current_login"""

new_switch_block = """            current_login = int(acc_info.login)
            
            # Check if there is an account switch OR a startup mismatch on 0 trades today
            from database import get_connection
            startup_mismatch = False
            try:
                conn = get_connection()
                cur = conn.cursor()
                cur.execute("SELECT initial_balance FROM bot_state WHERE id = 1")
                state_row = cur.fetchone()
                db_initial = float(state_row[0]) if (state_row and state_row[0] is not None) else 0.0
                
                # Check trades count today
                import datetime
                today_date = datetime.date.today()
                cur.execute("SELECT trades_today FROM daily_metrics WHERE trading_date = %s", (today_date,))
                metrics_row = cur.fetchone()
                trades_today_val = metrics_row[0] if metrics_row else 0
                
                # Check active positions count
                cur.execute("SELECT COUNT(*) FROM trades WHERE status = 'OPEN'")
                open_trades_count = cur.fetchone()[0] or 0
                
                cur.close()
                conn.close()
                
                # If 0 trades today and 0 open positions, and balance has mismatch > $0.01:
                if trades_today_val == 0 and open_trades_count == 0 and abs(db_initial - float(acc_info.equity)) > 0.01:
                    startup_mismatch = True
            except Exception as e:
                logger.error(f"Error checking startup metrics sync: {e}")
                
            login_changed = (active_login_id is not None and active_login_id != current_login)
            
            if login_changed or startup_mismatch:
                logger.info(f"Syncing metrics (login_changed={login_changed}, startup_mismatch={startup_mismatch}). Resetting metrics to {acc_info.equity:.2f}")
                from database import reset_database_metrics_for_new_account
                reset_database_metrics_for_new_account(current_login, acc_info.equity)
                
                # Update safeguards cache here to prevent circular imports
                try:
                    import risk_safeguards
                    import datetime
                    risk_safeguards._cached_start_equity = float(acc_info.equity)
                    risk_safeguards._cached_start_equity_date = datetime.date.today()
                    risk_safeguards._cached_last_login = int(current_login)
                except Exception as ex:
                    logger.error(f"Error updating risk_safeguards cache in main loop: {ex}")
                
            active_login_id = current_login"""

if old_switch_block in content:
    content = content.replace(old_switch_block, new_switch_block)
    print("main.py account switch block successfully updated.")
else:
    print("old_switch_block target not found in main.py!")

with open(main_path, "w", encoding="utf-8") as f:
    f.write(content)
print("File updated.")
