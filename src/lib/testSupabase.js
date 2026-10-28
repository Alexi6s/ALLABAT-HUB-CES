import { supabase } from './supabaseClient'

async function testSupabaseConnection() {
  try {
    const { data, error } = await supabase.auth.getSession()

    if (error) {
      console.error('Supabase connection failed:', error.message)
      return
    }

    console.log('SUCCESS: Supabase client initialized.')
    console.log('Session check completed.')
    console.log('An active session exists:', Boolean(data.session))
  } catch (error) {
    console.error('Connection test error:', error.message)
  }
}

testSupabaseConnection()